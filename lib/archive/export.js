'use strict';

// 容器导出：把若干容器的聊天记录、设置、Agent 数据、工作目录等写成一个 tar（可压缩）。
// 容器里的数据用 `cp <容器>:<路径> -` 取，再按 `diff`（相对镜像的改动）过滤，所以镜像自带的内容和缓存不会进归档。
// 宿主机侧（状态目录、工作目录）里的内容是容器可写的，按不可信输入处理：lstat 遍历，不跟随符号链接，
// 跳过 FIFO / 设备 / socket，不跨文件系统，打开时 O_NOFOLLOW。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PassThrough, pipeline } = require('stream');
const { once } = require('events');

const { encodeEntryHeader, readTarEntries, END_BLOCKS, pad } = require('./tar');
const plan = require('./plan');
const envText = require('../env-text');

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const MAX_SMALL_FILE = 64 * 1024 * 1024;

class ExportCancelled extends Error {
    constructor() {
        super('导出已取消');
        this.name = 'ExportCancelled';
    }
}

// 带背压的 tar 写入器
class TarWriter {
    constructor(sink, hooks = {}) {
        this.sink = sink;
        this.bytes = 0;
        this.entries = 0;
        this.hooks = hooks;
    }

    async raw(buffer) {
        this.hooks.check && this.hooks.check();
        this.bytes += buffer.length;
        if (!this.sink.write(buffer)) await once(this.sink, 'drain');
        this.hooks.onBytes && this.hooks.onBytes(buffer.length);
    }

    async addBuffer(name, buffer, meta = {}) {
        const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        await this.raw(encodeEntryHeader({ name, type: 'file', size: body.length, mode: meta.mode, mtime: meta.mtime }));
        if (body.length) await this.raw(body);
        const padding = pad(body.length);
        if (padding) await this.raw(Buffer.alloc(padding));
        this.entries += 1;
    }

    async addDir(name, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'dir', mode: meta.mode, mtime: meta.mtime }));
        this.entries += 1;
    }

    async addSymlink(name, linkname, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'symlink', linkname, mode: meta.mode, mtime: meta.mtime }));
        this.entries += 1;
    }

    // 已知大小的流式文件。流提前结束（文件被截短）用 0 补齐，保证 tar 结构正确
    async addStream(name, size, iterable, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'file', size, mode: meta.mode, mtime: meta.mtime }));
        let written = 0;
        for await (const chunk of iterable) {
            const room = size - written;
            if (room <= 0) break;
            const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
            await this.raw(piece);
            written += piece.length;
        }
        if (written < size) await this.raw(Buffer.alloc(size - written));
        const padding = pad(size);
        if (padding) await this.raw(Buffer.alloc(padding));
        this.entries += 1;
    }

    async finish() {
        await this.raw(END_BLOCKS);
    }
}

function zstdAvailable() {
    return typeof zlib.createZstdCompress === 'function';
}

// 压缩档：fast = zstd-3（没有 zstd 的 Node 退回 gzip-6）；small = zstd-10 / gzip-9
function createCompressor(mode) {
    if (zstdAvailable()) {
        const level = mode === 'small' ? 10 : 3;
        return {
            ext: 'tar.zst',
            stream: zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
        };
    }
    return { ext: 'tar.gz', stream: zlib.createGzip({ level: mode === 'small' ? 9 : 6 }) };
}

function archiveFileName(date = new Date()) {
    const pad2 = n => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
    return `manyoyo-export-${stamp}.${zstdAvailable() ? 'tar.zst' : 'tar.gz'}`;
}

// ---------- 宿主机侧：安全读取 ----------

// 读一个小文件（容器可写目录里的），不跟随符号链接，限制大小，非普通文件返回 null
function readSmallFileSafe(file, maxBytes = MAX_SMALL_FILE) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
        return null;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes) return null;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < stat.size) {
            const n = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
            if (n === 0) break;
            offset += n;
        }
        return buffer.subarray(0, offset);
    } finally {
        fs.closeSync(fd);
    }
}

// 单个宿主机文件：不跟随符号链接，不是普通文件就跳过
async function addHostFile(writer, full, entryName) {
    let fd;
    try {
        fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
        return false;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return false;
        await writer.addStream(entryName, stat.size, fileChunks(fd, stat.size), { mode: stat.mode, mtime: stat.mtimeMs / 1000 });
        return true;
    } finally {
        fs.closeSync(fd);
    }
}

async function* fileChunks(fd, size) {
    const chunk = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < size) {
        const want = Math.min(chunk.length, size - position);
        const n = await new Promise((resolve, reject) => fs.read(fd, chunk, 0, want, position, (err, bytes) => (err ? reject(err) : resolve(bytes))));
        if (n === 0) return;
        position += n;
        yield Buffer.from(chunk.subarray(0, n));
    }
}

/**
 * 遍历宿主机目录写入归档。prefix：归档里的路径前缀（不带结尾斜杠）。
 * 符号链接按链接本身存、不跟随；FIFO / 设备 / socket 跳过并计数；不进入另一个文件系统。
 */
async function addHostTree(writer, root, prefix, stats, hooks = {}) {
    const lstat = hooks.lstat || fs.lstatSync;
    let rootStat;
    try {
        rootStat = lstat(root);
    } catch (error) {
        return;
    }
    if (!rootStat.isDirectory()) return;
    await writer.addDir(prefix, { mode: rootStat.mode, mtime: rootStat.mtimeMs / 1000 });
    const dev = rootStat.dev;
    const stack = [{ dir: root, rel: prefix }];
    while (stack.length) {
        const { dir, rel } = stack.pop();
        let names;
        try {
            names = fs.readdirSync(dir).sort();
        } catch (error) {
            stats.skippedUnreadable = (stats.skippedUnreadable || 0) + 1;
            continue;
        }
        for (const name of names) {
            hooks.check && hooks.check();
            const full = path.join(dir, name);
            const entryName = `${rel}/${name}`;
            let st;
            try {
                st = lstat(full);
            } catch (error) {
                continue;
            }
            if (st.isSymbolicLink()) {
                let target = '';
                try { target = fs.readlinkSync(full); } catch (error) { continue; }
                await writer.addSymlink(entryName, target, { mode: st.mode, mtime: st.mtimeMs / 1000 });
                stats.symlinks = (stats.symlinks || 0) + 1;
            } else if (st.isDirectory()) {
                if (st.dev !== dev) {
                    stats.skippedOtherFs = (stats.skippedOtherFs || 0) + 1;
                    continue;
                }
                await writer.addDir(entryName, { mode: st.mode, mtime: st.mtimeMs / 1000 });
                stack.push({ dir: full, rel: entryName });
            } else if (st.isFile()) {
                if (st.dev !== dev) {
                    stats.skippedOtherFs = (stats.skippedOtherFs || 0) + 1;
                    continue;
                }
                let fd;
                try {
                    fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
                } catch (error) {
                    stats.skippedUnreadable = (stats.skippedUnreadable || 0) + 1;
                    continue;
                }
                try {
                    const fst = fs.fstatSync(fd);
                    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
                        stats.skippedSpecial = (stats.skippedSpecial || 0) + 1;
                        continue;
                    }
                    await writer.addStream(entryName, fst.size, fileChunks(fd, fst.size), { mode: fst.mode, mtime: fst.mtimeMs / 1000 });
                    stats.files = (stats.files || 0) + 1;
                    stats.bytes = (stats.bytes || 0) + fst.size;
                } finally {
                    fs.closeSync(fd);
                }
            } else {
                stats.skippedSpecial = (stats.skippedSpecial || 0) + 1;
            }
        }
    }
}

// ---------- 密钥 ----------

function redactEnvMap(map) {
    if (!map || typeof map !== 'object') return map;
    const out = {};
    for (const [key, value] of Object.entries(map)) out[key] = plan.isSecretName(key) ? '' : value;
    return out;
}

function redactHistory(history) {
    const copy = JSON.parse(JSON.stringify(history));
    const snap = copy.runtimeSnapshot;
    if (snap && typeof snap === 'object') {
        snap.env = redactEnvMap(snap.env);
        if (snap.first && typeof snap.first === 'object') snap.first.env = redactEnvMap(snap.first.env);
    }
    return copy;
}

function redactEnvText(text) {
    const { entries } = envText.parseEnvText(text);
    return envText.serializeEnvEntries(entries.map(item => ({ key: item.key, value: plan.isSecretName(item.key) ? '' : item.value })));
}

// ---------- 容器里的数据 ----------

/**
 * 从 cp 流里取需要的条目写进归档。
 * scope：容器内 cp 的路径；keep(absPath) 决定是否保留。
 */
async function addContainerScope({ writer, runtime, name, scope, prefix, keep, stats, hooks }) {
    const cp = runtime.cp(name, scope);
    const parent = path.posix.dirname(scope);
    try {
        for await (const { meta, body } of readTarEntries(cp.stream)) {
            hooks.check && hooks.check();
            const abs = plan.normalizeContainerPath(path.posix.join(parent, meta.name));
            if (!abs || !plan.isUnder(abs, scope) || !keep(abs, meta)) {
                stats.layerDropped = (stats.layerDropped || 0) + 1;
                continue;
            }
            const entryName = `${prefix}/${abs.replace(/^\/+/, '')}`;
            if (meta.type === 'file') {
                await writer.addStream(entryName, meta.size, body, { mode: meta.mode, mtime: meta.mtime });
                stats.layerFiles = (stats.layerFiles || 0) + 1;
                stats.layerBytes = (stats.layerBytes || 0) + meta.size;
            } else if (meta.type === 'dir') {
                await writer.addDir(entryName, { mode: meta.mode, mtime: meta.mtime });
            } else if (meta.type === 'symlink') {
                await writer.addSymlink(entryName, meta.linkname, { mode: meta.mode, mtime: meta.mtime });
            } else {
                stats.layerSkippedSpecial = (stats.layerSkippedSpecial || 0) + 1;
            }
        }
    } finally {
        if (cp.stream.destroy) cp.stream.destroy();
    }
    const result = await cp.done;
    if (result && result.code !== 0 && !/no such|not exist|could not find|not found/i.test(String(result.stderr || ''))) {
        throw new Error(`读取容器内 ${scope} 失败: ${String(result.stderr || '').trim().slice(0, 200)}`);
    }
}

function eventFilesFor(webHistoryDir, containerName) {
    const key = encodeURIComponent(containerName);
    const out = [];
    for (const sub of ['events', 'projections']) {
        const dir = path.join(webHistoryDir, sub);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (error) { continue; }
        for (const file of names) {
            const base = file.replace(/\.jsonl?$/, '');
            if (base === key || base.startsWith(`${key}${encodeURIComponent('~')}`)) out.push({ sub, file, full: path.join(dir, file) });
        }
    }
    return out;
}

/**
 * 主流程。
 * options：
 *   out            最终字节的 Writable
 *   containers     [{ name }]
 *   items          内容项 id 数组（plan.normalizeItems 的结果）
 *   includeSecrets 是否带密钥
 *   compression    'fast' | 'small'
 *   deps           { homeDir, webHistoryDir, runtime, containerState, version, loadHistory(name) }
 *   hooks          { check(), onBytes(n), onStage(info), onPause(name), onUnpause(name) }
 * 返回 { entries, bytes, stats, ext }
 */
async function exportArchive(options) {
    const { out, containers, items, includeSecrets, deps } = options;
    const hooks = options.hooks || {};
    const enabled = new Set(items);
    const compressor = createCompressor(options.compression);
    const tarSink = new PassThrough();
    const finished = new Promise((resolve, reject) => {
        pipeline(tarSink, compressor.stream, out, error => (error ? reject(error) : resolve()));
    });
    const writer = new TarWriter(tarSink, hooks);
    const stats = {};
    const paused = [];

    const run = async () => {
        const manifestContainers = [];
        const workdirs = new Map();
        const prepared = [];
        for (let idx = 0; idx < containers.length; idx += 1) {
            const name = containers[idx].name;
            const info = deps.runtime.inspect(name);
            const history = deps.loadHistory(name);
            const applied = history.applied || {};
            const snapshot = history.runtimeSnapshot || null;
            const hostPath = (snapshot && snapshot.hostPath) || applied.hostPath || '';
            const containerPath = (snapshot && snapshot.containerPath) || applied.containerPath || '';
            let workKey = '';
            if (enabled.has('workdir') && hostPath) {
                try { workKey = fs.realpathSync(hostPath); } catch (error) { workKey = ''; }
            }
            if (workKey && !workdirs.has(workKey)) workdirs.set(workKey, workdirs.size);
            prepared.push({ idx, name, info, history, hostPath, containerPath, workKey });
            manifestContainers.push({
                idx,
                name,
                remark: history.remark || '',
                image: info ? info.image : (applied.imageName ? `${applied.imageName}:${applied.imageVersion || ''}` : ''),
                containerPath,
                hostPath,
                fidelity: snapshot ? 'full' : 'partial',
                work: workKey ? workdirs.get(workKey) : null,
                exists: Boolean(info)
            });
        }
        const manifest = {
            format: plan.FORMAT,
            manyoyoVersion: deps.version || '',
            createdAt: new Date().toISOString(),
            items: [...enabled],
            tier: plan.matchTier(items),
            includeSecrets: Boolean(includeSecrets),
            containers: manifestContainers,
            workdirs: [...workdirs.entries()].map(([hostReal, n]) => ({ n, hostPath: hostReal }))
        };
        await writer.addBuffer('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

        const workDone = new Set();
        for (const item of prepared) {
            hooks.check && hooks.check();
            hooks.onStage && hooks.onStage({ stage: '准备', container: item.name });
            const prefix = `c/${item.idx}`;
            let pausedHere = false;
            try {
                // 运行中才暂停：冻结容器里所有进程，sqlite 一致，宿主机读工作目录时容器也换不了目录
                if (item.info && item.info.status === 'running') {
                    hooks.onPause && hooks.onPause(item.name, item.info);
                    deps.runtime.pause(item.name);
                    pausedHere = true;
                    paused.push(item.name);
                }
                await exportOneContainer({ writer, item, prefix, enabled, includeSecrets, deps, hooks, stats });
                if (item.workKey && !workDone.has(item.workKey)) {
                    workDone.add(item.workKey);
                    hooks.onStage && hooks.onStage({ stage: '工作目录', container: item.name });
                    await addHostTree(writer, item.workKey, `w/${workdirs.get(item.workKey)}`, stats, hooks);
                }
            } finally {
                if (pausedHere) {
                    try { deps.runtime.unpause(item.name); } catch (error) { /* 恢复失败由调用方的任务记录兜底 */ }
                    paused.splice(paused.indexOf(item.name), 1);
                    hooks.onUnpause && hooks.onUnpause(item.name);
                }
            }
        }
        await writer.addBuffer('END.json', `${JSON.stringify({ entries: writer.entries + 1, bytes: writer.bytes, stats })}\n`);
        await writer.finish();
    };

    try {
        await run();
        tarSink.end();
        await finished;
    } catch (error) {
        tarSink.destroy(error);
        await finished.catch(() => {});
        throw error;
    } finally {
        // 异常路径上还没恢复的暂停容器
        for (const name of paused.splice(0)) {
            try { deps.runtime.unpause(name); } catch (error) { /* ignore */ }
            hooks.onUnpause && hooks.onUnpause(name);
        }
    }
    return { entries: writer.entries, bytes: writer.bytes, stats, ext: compressor.ext };
}

async function exportOneContainer({ writer, item, prefix, enabled, includeSecrets, deps, hooks, stats }) {
    const { name, history, info } = item;
    // 1. 网页聊天记录
    if (enabled.has('history')) {
        hooks.onStage && hooks.onStage({ stage: '聊天记录', container: name });
        const data = includeSecrets ? history : redactHistory(history);
        await writer.addBuffer(`${prefix}/history.json`, `${JSON.stringify(data)}\n`);
        for (const file of eventFilesFor(deps.webHistoryDir, name)) {
            await addHostFile(writer, file.full, `${prefix}/${file.sub}/${file.file}`);
        }
    }
    const id = info ? info.id : '';
    const stateRoot = id && deps.containerState.isValidId(id) ? deps.containerState.paths(deps.homeDir, id) : null;
    // 2. 容器设置
    if (enabled.has('settings') && stateRoot) {
        hooks.onStage && hooks.onStage({ stage: '容器设置', container: name });
        const env = readSmallFileSafe(stateRoot.env, 256 * 1024);
        if (env) await writer.addBuffer(`${prefix}/state/env`, includeSecrets ? env : redactEnvText(env.toString('utf8')));
        for (const [file, label] of [[stateRoot.autostart, 'autostart.sh'], [stateRoot.systemPrompt, 'system-prompt.json'], [stateRoot.network, 'network.json'], [stateRoot.envFiles, 'env-files.json']]) {
            const body = readSmallFileSafe(file, 1024 * 1024);
            if (body) await writer.addBuffer(`${prefix}/state/${label}`, body);
        }
    }
    // 3. 图片与回退快照（容器可写目录，按不可信输入遍历）
    if (stateRoot && enabled.has('uploads')) {
        hooks.onStage && hooks.onStage({ stage: '聊天图片', container: name });
        await addHostTree(writer, path.join(stateRoot.box, 'uploads'), `${prefix}/box/uploads`, stats, hooks);
    }
    if (stateRoot && enabled.has('snapshots')) {
        hooks.onStage && hooks.onStage({ stage: '回退快照', container: name });
        await addHostTree(writer, path.join(stateRoot.box, 'snap.git'), `${prefix}/box/snap.git`, stats, hooks);
    }
    // 4. 容器里的改动
    const layerEnabled = ['agentSessions', 'agentExtras', 'systemLayer'].filter(id2 => enabled.has(id2));
    if (info && layerEnabled.length) {
        hooks.onStage && hooks.onStage({ stage: '容器内数据', container: name });
        const diff = plan.parseDiff(deps.runtime.diff(name));
        const mounts = info.mounts || [];
        const enabledSet = new Set(layerEnabled);
        const keep = (abs) => {
            const cls = plan.classifyLayerPath(abs, mounts);
            return cls !== null && enabledSet.has(cls) && diff.added.has(abs);
        };
        for (const scope of plan.layerScopes(enabledSet, [...diff.added.keys()])) {
            if (plan.classifyLayerPath(scope, mounts) === null) continue;
            await addContainerScope({ writer, runtime: deps.runtime, name, scope, prefix: `${prefix}/layer`, keep, stats, hooks });
        }
        if (enabledSet.has('systemLayer')) {
            const deleted = diff.deleted.filter(p => plan.classifyLayerPath(p, mounts) === 'systemLayer');
            await writer.addBuffer(`${prefix}/layer-deleted.json`, `${JSON.stringify(deleted)}\n`);
        }
    }
}

module.exports = {
    ExportCancelled,
    TarWriter,
    exportArchive,
    createCompressor,
    archiveFileName,
    zstdAvailable,
    addHostTree,
    addHostFile,
    readSmallFileSafe,
    redactHistory,
    redactEnvText,
    eventFilesFor
};
