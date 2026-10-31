'use strict';

// 容器导出：把若干容器的聊天记录、设置、Agent 数据、工作目录等写成一个 tar（可压缩）。
// 容器里的数据用 `cp <容器>:<路径> -` 取，再按 `diff`（相对镜像的改动）过滤，所以镜像自带的内容和缓存不会进归档。
// 宿主机侧（状态目录、工作目录）里的内容是容器可写的，按不可信输入处理：lstat 遍历，不跟随符号链接，
// 跳过 FIFO / 设备 / socket，不跨文件系统，打开时 O_NOFOLLOW。

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { once } = require('events');

const { encodeEntryHeader, readTarEntries, END_BLOCKS, pad } = require('./tar');
const plan = require('./plan');
const redact = require('./redact');
const envText = require('../env-text');
const { summarizeRisks } = require('./risks');
const { duBytes } = require('./size');

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const MAX_SMALL_FILE = 64 * 1024 * 1024;

class ExportCancelled extends Error {
    constructor() {
        super('导出已取消');
        this.name = 'ExportCancelled';
    }
}

// 等 drain；输出被关掉（客户端断开等）时立即报错，而不是永远等下去
function waitDrain(sink) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            sink.removeListener('drain', onDrain);
            sink.removeListener('close', onClose);
            sink.removeListener('error', onError);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('输出已关闭（客户端可能已断开）')); };
        const onError = error => { cleanup(); reject(error); };
        if (sink.destroyed) return onClose();
        sink.once('drain', onDrain);
        sink.once('close', onClose);
        sink.once('error', onError);
    });
}

// 带背压的 tar 写入器
class TarWriter {
    constructor(sink, hooks = {}) {
        this.sink = sink;
        this.bytes = 0;
        this.entries = 0;
        this.hooks = hooks;
        this.lastWriteAt = Date.now();
    }

    async raw(buffer) {
        this.hooks.check && this.hooks.check();
        this.bytes += buffer.length;
        this.lastWriteAt = Date.now();
        if (!this.sink.write(buffer)) await waitDrain(this.sink);
        this.hooks.onBytes && this.hooks.onBytes(buffer.length);
    }

    async addBuffer(name, buffer, meta = {}) {
        const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        await this.raw(encodeEntryHeader({ name, type: 'file', size: body.length, mode: meta.mode, mtime: meta.mtime, uid: meta.uid, gid: meta.gid }));
        if (body.length) await this.raw(body);
        const padding = pad(body.length);
        if (padding) await this.raw(Buffer.alloc(padding));
        this.entries += 1;
    }

    async addDir(name, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'dir', mode: meta.mode, mtime: meta.mtime, uid: meta.uid, gid: meta.gid }));
        this.entries += 1;
    }

    async addSymlink(name, linkname, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'symlink', linkname, mode: meta.mode, mtime: meta.mtime, uid: meta.uid, gid: meta.gid }));
        this.entries += 1;
    }

    // 已知大小的流式文件。流提前结束（文件被截短）用 0 补齐，保证 tar 结构正确
    async addStream(name, size, iterable, meta = {}) {
        await this.raw(encodeEntryHeader({ name, type: 'file', size, mode: meta.mode, mtime: meta.mtime, uid: meta.uid, gid: meta.gid }));
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
            flushKind: zlib.constants.ZSTD_e_flush,
            stream: zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
        };
    }
    return { ext: 'tar.gz', flushKind: zlib.constants.Z_SYNC_FLUSH, stream: zlib.createGzip({ level: mode === 'small' ? 9 : 6 }) };
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

function redactHistory(history) {
    const copy = JSON.parse(JSON.stringify(history));
    const snap = copy.runtimeSnapshot;
    if (snap && typeof snap === 'object') {
        snap.env = redact.redactEnvMap(snap.env);
        if (snap.first && typeof snap.first === 'object') snap.first.env = redact.redactEnvMap(snap.first.env);
        // 命令和脚本里可能直接写着 NAME=令牌
        for (const key of ['autostart', 'agentPromptCommand', 'shellPrefix', 'shell', 'shellSuffix']) {
            if (typeof snap[key] === 'string') snap[key] = redact.redactCommandText(snap[key]);
        }
    }
    if (typeof copy.agentPromptCommand === 'string') copy.agentPromptCommand = redact.redactCommandText(copy.agentPromptCommand);
    if (copy.applied && typeof copy.applied === 'object') {
        for (const key of ['agentPromptCommand', 'shellPrefix', 'shell', 'shellSuffix']) {
            if (typeof copy.applied[key] === 'string') copy.applied[key] = redact.redactCommandText(copy.applied[key]);
        }
    }
    return copy;
}

function redactEnvText(text) {
    const { entries } = envText.parseEnvText(text);
    return envText.serializeEnvEntries(entries.map(item => ({ key: item.key, value: redact.redactEnvValue(item.key, item.value) })));
}

// 本容器已知的密钥值：快照与 box/env 里的密钥变量、环境变量文件里的密钥变量（宿主机文件，只读）
function collectSecretValues({ history, boxEnv, envFilePaths }) {
    const values = [];
    const snap = history && history.runtimeSnapshot;
    if (snap && typeof snap === 'object') {
        values.push(...redact.secretValuesOfEnv(snap.env));
        if (snap.first && typeof snap.first === 'object') values.push(...redact.secretValuesOfEnv(snap.first.env));
    }
    const fromText = text => {
        const map = {};
        for (const entry of envText.parseEnvText(text).entries) map[entry.key] = entry.value;
        values.push(...redact.secretValuesOfEnv(map));
    };
    if (boxEnv) fromText(boxEnv.toString('utf8'));
    for (const file of envFilePaths || []) {
        const body = readSmallFileSafe(file, 256 * 1024);
        if (body) fromText(body.toString('utf8'));
    }
    return values;
}

// ---------- 文本里的密钥抹除 ----------

const SCRUB_BUFFER_MAX = 32 * 1024 * 1024;

async function collectBytes(iterable, size) {
    const parts = [];
    let got = 0;
    for await (const chunk of iterable) {
        parts.push(chunk);
        got += chunk.length;
    }
    return got === size ? Buffer.concat(parts) : Buffer.concat([...parts, Buffer.alloc(Math.max(0, size - got))]).subarray(0, size);
}

async function writeToFile(file, iterable) {
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let first = true;
    let binary = false;
    try {
        for await (const chunk of iterable) {
            if (first) { first = false; binary = !redact.isProbablyText(chunk); }
            if (!out.write(chunk)) await once(out, 'drain');
        }
    } finally {
        out.end();
        await once(out, 'close').catch(() => {});
    }
    return binary;
}

/**
 * 把一个文本条目写进归档，同时抹掉密钥。小文件放内存；大文件落到临时文件，逐行处理（跨行的私钥块在这条路径上抹不掉）。
 * 二进制文件（sqlite 等）原样写入。
 */
async function addScrubbedStream({ writer, entryName, size, iterable, meta, scrubber, tmpDir, stats }) {
    if (size <= SCRUB_BUFFER_MAX) {
        const buffer = await collectBytes(iterable, size);
        if (!redact.isProbablyText(buffer)) return writer.addBuffer(entryName, buffer, meta);
        const text = buffer.toString('utf8');
        const scrubbed = scrubber.scrub(text);
        if (scrubbed !== text) stats.scrubbedFiles = (stats.scrubbedFiles || 0) + 1;
        return writer.addBuffer(entryName, scrubbed === text ? buffer : Buffer.from(scrubbed, 'utf8'), meta);
    }
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const raw = path.join(tmpDir, `scrub-${crypto.randomBytes(6).toString('hex')}`);
    const cooked = `${raw}.out`;
    try {
        const binary = await writeToFile(raw, iterable);
        let source = raw;
        if (!binary) {
            // 逐行处理，没有改动的行原样写出（保留 CRLF、非 UTF-8 字节、末尾有没有换行）；跨行的私钥块在这条路径上抹不掉
            const out = fs.createWriteStream(cooked, { flags: 'wx', mode: 0o600 });
            let changed = false;
            const emit = async (line, newline) => {
                const text = line.toString('utf8');
                const scrubbed = scrubber.scrub(text);
                if (scrubbed !== text) changed = true;
                const chunk = Buffer.concat([scrubbed === text ? line : Buffer.from(scrubbed, 'utf8'), newline ? Buffer.from('\n') : Buffer.alloc(0)]);
                if (!out.write(chunk)) await once(out, 'drain');
            };
            try {
                let pending = Buffer.alloc(0);
                for await (const chunk of fs.createReadStream(raw)) {
                    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                    let start = 0;
                    for (let idx = pending.indexOf(10, start); idx >= 0; idx = pending.indexOf(10, start)) {
                        await emit(pending.subarray(start, idx), true);
                        start = idx + 1;
                    }
                    pending = pending.subarray(start);
                }
                if (pending.length) await emit(pending, false);
            } finally {
                out.end();
                await once(out, 'close').catch(() => {});
            }
            if (changed) stats.scrubbedFiles = (stats.scrubbedFiles || 0) + 1;
            source = cooked;
        }
        const fd = fs.openSync(source, fs.constants.O_RDONLY);
        try {
            const st = fs.fstatSync(fd);
            await writer.addStream(entryName, st.size, fileChunks(fd, st.size), meta);
        } finally {
            fs.closeSync(fd);
        }
    } finally {
        fs.rmSync(raw, { force: true });
        fs.rmSync(cooked, { force: true });
    }
}

// 宿主机上的文本文件（聊天事件、投影）：不带密钥时抹掉密钥再写进归档
async function addHostFileScrubbed(writer, full, entryName, options) {
    let fd;
    try {
        fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
        return false;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return false;
        await addScrubbedStream({ ...options, writer, entryName, size: stat.size, iterable: fileChunks(fd, stat.size), meta: { mode: stat.mode, mtime: stat.mtimeMs / 1000 } });
        return true;
    } finally {
        fs.closeSync(fd);
    }
}

// ---------- 容器里的数据 ----------

/**
 * 从 cp 流里取需要的条目写进归档。
 * scope：容器内 cp 的路径；keep(absPath) 决定是否保留；rewrite(abs, meta, body) 返回 true 表示条目已由它写入（密钥处理）。
 */
async function addContainerScope({ writer, runtime, name, scope, prefix, keep, rewrite, stats, hooks }) {
    const cp = runtime.cp(name, scope);
    const parent = path.posix.dirname(scope);
    // 取消（含客户端断开）时 cp 可能正堵在读上，不会再走到 check：直接杀掉它
    const onAbort = () => {
        if (cp.kill) cp.kill();
        if (cp.stream.destroy) cp.stream.destroy(new Error('已取消'));
    };
    if (hooks.signal) hooks.signal.addEventListener('abort', onAbort, { once: true });
    try {
        for await (const { meta, body } of readTarEntries(cp.stream)) {
            hooks.check && hooks.check();
            const abs = plan.normalizeContainerPath(path.posix.join(parent, meta.name));
            if (!abs || !plan.isUnder(abs, scope) || !keep(abs, meta)) {
                stats.layerDropped = (stats.layerDropped || 0) + 1;
                continue;
            }
            const entryName = `${prefix}/${abs.replace(/^\/+/, '')}`;
            const entryMeta = { mode: meta.mode, mtime: meta.mtime, uid: meta.uid, gid: meta.gid };
            if (meta.type === 'file') {
                if (!(rewrite && await rewrite(abs, meta, body, entryName, entryMeta))) {
                    await writer.addStream(entryName, meta.size, body, entryMeta);
                }
                stats.layerFiles = (stats.layerFiles || 0) + 1;
                stats.layerBytes = (stats.layerBytes || 0) + meta.size;
            } else if (meta.type === 'dir') {
                await writer.addDir(entryName, entryMeta);
            } else if (meta.type === 'symlink') {
                await writer.addSymlink(entryName, meta.linkname, entryMeta);
            } else {
                stats.layerSkippedSpecial = (stats.layerSkippedSpecial || 0) + 1;
            }
        }
    } catch (error) {
        // 出错 / 取消时才强停子进程；正常读完要等它自己退出（提前销毁流会让它收到 SIGPIPE，退出码非 0）
        if (cp.kill) cp.kill();
        if (cp.stream.destroy) cp.stream.destroy();
        throw error;
    } finally {
        if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
    }
    // tar 的结束块之后 cp 还可能补零：读掉剩下的，子进程才能正常退出
    if (cp.stream.resume) cp.stream.resume();
    const result = await cp.done;
    if (result && result.code !== 0 && !/no such|not exist|could not find|not found/i.test(String(result.stderr || ''))) {
        throw new Error(`读取容器内 ${scope} 失败: ${String(result.stderr || '').trim().slice(0, 200)}`);
    }
}

// 读容器里的一个小文件（准备阶段收集密钥值用）；读不到返回 null。
// 拿到内容就直接杀掉 cp：只读第一个条目时流没读完，cp 会堵在写管道上不退出（等 done 会永远等下去）
async function readContainerFile(runtime, name, abs, limit = 4 * 1024 * 1024) {
    const cp = runtime.cp(name, abs);
    try {
        for await (const { meta, body } of readTarEntries(cp.stream)) {
            if (meta.type !== 'file' || meta.size > limit) return null;
            return await collectBytes(body, meta.size);
        }
        return null;
    } catch (error) {
        return null;
    } finally {
        if (cp.kill) cp.kill();
        if (cp.stream.destroy) cp.stream.destroy();
        await cp.done.catch(() => {});
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

const LAYER_ITEM_IDS = ['agentSessions', 'agentExtras', 'systemLayer'];

/**
 * 第一段：准备。读容器信息、聊天记录、风险摘要、diff（异步、可取消）、算估算大小。不暂停容器、不写任何输出。
 * options：containers [{name}]、items、includeSecrets、deps、hooks（check / onStage）、signal
 * 返回 prepared，交给 writeExport。
 */
async function prepareExport(options) {
    const { containers, items, includeSecrets, deps, signal } = options;
    const hooks = options.hooks || {};
    const enabled = new Set(items);
    const layerEnabled = LAYER_ITEM_IDS.filter(id => enabled.has(id));
    const manifestContainers = [];
    const workdirs = new Map();
    const prepared = [];
    const scrubber = includeSecrets ? null : new redact.SecretScrubber();
    for (let idx = 0; idx < containers.length; idx += 1) {
        hooks.check && hooks.check();
        const name = containers[idx].name;
        hooks.onStage && hooks.onStage({ stage: '准备', container: name });
        const info = await deps.runtime.inspect(name, { signal });
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
        const id = info && info.id && deps.containerState.isValidId(info.id) ? info.id : '';
        const stateRoot = id ? deps.containerState.paths(deps.homeDir, id) : null;
        const stateText = file => {
            const body = stateRoot ? readSmallFileSafe(file, 1024 * 1024) : null;
            return body ? body.toString('utf8') : '';
        };
        const parseJson = text => { try { return text ? JSON.parse(text) : null; } catch (error) { return null; } };
        // 面板里改过的网络规则、环境变量文件以状态目录为准
        const stateNetwork = parseJson(stateRoot ? stateText(stateRoot.network) : '');
        const stateEnvFiles = parseJson(stateRoot ? stateText(stateRoot.envFiles) : '');
        const envFileList = stateEnvFiles && Array.isArray(stateEnvFiles.files) ? stateEnvFiles.files.filter(f => typeof f === 'string') : null;
        const item = { idx, name, info, history, hostPath, containerPath, workKey, stateRoot, diff: null };
        // 容器里的改动（异步 diff，只留会被导出的路径）
        if (info && layerEnabled.length) {
            hooks.onStage && hooks.onStage({ stage: '读取容器改动', container: name });
            const mounts = info.mounts || [];
            const enabledSet = new Set(layerEnabled);
            // parents：所有改动路径（不管分类）的上一级目录，用来认出“只是被牵连的父目录”
            const diff = { added: new Map(), deleted: [], parents: new Set() };
            await deps.runtime.diff(name, {
                signal,
                onEntry: (kind, raw) => {
                    const abs = plan.normalizeContainerPath(raw);
                    if (!abs) return;
                    diff.parents.add(path.posix.dirname(abs));
                    const cls = plan.classifyLayerPath(abs, mounts);
                    if (cls === null) return;
                    if (kind === 'D') {
                        if (cls === 'systemLayer' && enabledSet.has('systemLayer')) diff.deleted.push(abs);
                    } else if (enabledSet.has(cls)) {
                        diff.added.set(abs, kind);
                    }
                }
            });
            item.diff = diff;
        }
        if (scrubber) {
            const boxEnv = stateRoot ? readSmallFileSafe(stateRoot.env, 256 * 1024) : null;
            scrubber.add(collectSecretValues({ history, boxEnv, envFilePaths: envFileList || [] }));
            // 容器里的配置文件里的密钥（只有这些文件会被导出时才需要）
            if (item.diff) {
                for (const abs of redact.FIELD_REWRITE_FILES) {
                    if (!item.diff.added.has(abs)) continue;
                    const body = await readContainerFile(deps.runtime, name, abs);
                    if (body) scrubber.add(redact.redactFieldFile(abs, body.toString('utf8')).removed);
                }
            }
        }
        prepared.push(item);
        manifestContainers.push({
            idx,
            name,
            remark: history.remark || '',
            image: info ? info.image : (applied.imageName ? `${applied.imageName}:${applied.imageVersion || ''}` : ''),
            containerPath,
            hostPath,
            fidelity: snapshot ? 'full' : 'partial',
            work: workKey ? workdirs.get(workKey) : null,
            exists: Boolean(info),
            // 导入时要让用户确认的高风险设置
            risks: summarizeRisks(snapshot, enabled.has('settings') ? stateText(stateRoot && stateRoot.autostart) : '', { network: stateNetwork, envFiles: envFileList })
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
    // 估算：宿主机侧的目录大小；容器里的数据读 diff 也不知道大小，只要选了就算“不完整”
    const duFn = deps.duBytes || duBytes;
    let bytes = 0;
    let complete = !LAYER_ITEM_IDS.some(id => enabled.has(id));
    const sized = new Set();
    const addSize = async dir => {
        if (sized.has(dir)) return;
        sized.add(dir);
        hooks.check && hooks.check();
        const n = await duFn(dir, { signal });
        if (n === null) complete = false;
        else bytes += n;
    };
    for (const item of prepared) {
        if (item.workKey) await addSize(item.workKey);
        if (item.stateRoot && enabled.has('uploads')) await addSize(path.join(item.stateRoot.box, 'uploads'));
        if (item.stateRoot && enabled.has('snapshots')) await addSize(path.join(item.stateRoot.box, 'snap.git'));
    }
    return { manifest, enabled, items: prepared, workdirs, scrubber, includeSecrets: Boolean(includeSecrets), estimate: { bytes, complete } };
}

// 暂停之后恢复运行失败：容器还冻着，必须让调用方登记着它（收尾时会再试，崩溃恢复也要靠任务记录），并让整个导出失败，
// 不能带着“可能读不全”的数据继续
function stillPausedError(name, reason) {
    const error = new Error(`容器 ${name} ${reason}，恢复运行也失败了，导出已中止；如果它还处于暂停，请手动恢复（例如 docker/podman unpause ${name}）`);
    error.stillPaused = name;
    return error;
}

// 暂停（读容器内数据期间）：失败不再退回“停止容器”；返回 { pausedHere, warning }
async function pauseForLayer({ item, deps, hooks, stats }) {
    const name = item.name;
    if (!item.info || item.info.status !== 'running') return { pausedHere: false };
    // 先登记再暂停：登记之后崩溃，下次启动才知道要恢复
    hooks.onPause && hooks.onPause(name, item.info, 'pause');
    try {
        await deps.runtime.pause(name);
    } catch (error) {
        let again = null;
        try { again = await deps.runtime.inspect(name); } catch (e) { again = null; }
        if (!again || again.status === 'stopped') { // 已经不在运行：当成已停止的容器读
            hooks.onUnpause && hooks.onUnpause(name);
            return { pausedHere: false };
        }
        if (again.status === 'paused') {
            // 开始时是运行中，现在是暂停：是我们的暂停命令生效了只是报了错，先恢复，改成不暂停直接读
            try {
                await deps.runtime.unpause(name);
            } catch (e) {
                throw stillPausedError(name, '暂停命令报错后处于暂停状态');
            }
        }
        hooks.onUnpause && hooks.onUnpause(name);
        stats.pauseUnusable = (stats.pauseUnusable || 0) + 1;
        return { pausedHere: false, warning: `容器 ${name} 没能暂停，导出的是运行中的状态` };
    }
    // 暂停后读不到容器文件：恢复运行，改成不暂停直接读（数据可能是导出瞬间的状态，但至少带得全）
    if (typeof deps.runtime.canRead === 'function' && !(await deps.runtime.canRead(name))) {
        try {
            await deps.runtime.unpause(name);
        } catch (error) {
            throw stillPausedError(name, '暂停后读不到文件');
        }
        hooks.onUnpause && hooks.onUnpause(name);
        stats.pauseUnusable = (stats.pauseUnusable || 0) + 1;
        return { pausedHere: false, warning: `容器 ${name} 暂停后读不到文件，导出的是运行中的状态` };
    }
    return { pausedHere: true };
}

/**
 * 第二段：写出。options：out（最终字节的 Writable）、compression、deps、hooks（check / onBytes / onStage / onPause / onUnpause / onWarning）
 * 返回 { entries, bytes, stats, ext, warnings }
 */
async function writeExport(prepared, options) {
    const { out, deps } = options;
    const hooks = options.hooks || {};
    const { manifest, enabled, includeSecrets, scrubber } = prepared;
    const compressor = createCompressor(options.compression);
    // tar 直接写进压缩器（中间不再隔一层 PassThrough），冲刷才会排在已写入的数据之后
    const tarSink = compressor.stream;
    const finished = new Promise((resolve, reject) => {
        pipeline(compressor.stream, out, error => (error ? reject(error) : resolve()));
    });
    // 输出先于主流程出错（客户端断开）时不能变成未处理的拒绝：错误由主流程在 check / 写入处发现
    finished.catch(() => {});
    const writer = new TarWriter(tarSink, hooks);
    const stats = {};
    const warnings = [];
    const paused = new Set();
    const tmpDir = path.join(deps.homeDir || os.homedir(), '.manyoyo', 'tmp');

    // 心跳：压缩器里攒着数据、超过 2 秒没有新输出时冲刷一次，反向代理的读超时才不会误判成停了
    let flushedAt = 0;
    const heartbeat = setInterval(() => {
        if (writer.bytes > flushedAt && Date.now() - writer.lastWriteAt >= 2000) {
            flushedAt = writer.bytes;
            try { compressor.stream.flush(compressor.flushKind, () => {}); } catch (error) { /* 已经关闭 */ }
        }
    }, 1000);
    heartbeat.unref();
    const flushNow = () => {
        flushedAt = writer.bytes;
        try { compressor.stream.flush(compressor.flushKind, () => {}); } catch (error) { /* 已经关闭 */ }
    };

    const run = async () => {
        await writer.addBuffer('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
        flushNow();
        const workDone = new Set();
        for (const item of prepared.items) {
            hooks.check && hooks.check();
            const prefix = `c/${item.idx}`;
            await exportHostParts({ writer, item, prefix, enabled, includeSecrets, scrubber, deps, hooks, stats, tmpDir });
            await exportLayer({ writer, item, prefix, enabled, includeSecrets, scrubber, deps, hooks, stats, tmpDir, paused, warnings });
            if (item.workKey && !workDone.has(item.workKey)) {
                workDone.add(item.workKey);
                hooks.onStage && hooks.onStage({ stage: '工作目录', container: item.name });
                await addHostTree(writer, item.workKey, `w/${prepared.workdirs.get(item.workKey)}`, stats, hooks);
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
        clearInterval(heartbeat);
        // 异常路径上还没恢复的暂停容器
        for (const name of [...paused]) {
            try {
                await deps.runtime.unpause(name);
            } catch (error) {
                // 恢复不了：任务记录里继续留着它，下次 serve 启动时会再恢复
                continue;
            }
            paused.delete(name);
            hooks.onUnpause && hooks.onUnpause(name);
        }
    }
    return { entries: writer.entries, bytes: writer.bytes, stats, ext: compressor.ext, warnings };
}

async function exportHostParts({ writer, item, prefix, enabled, includeSecrets, scrubber, deps, hooks, stats, tmpDir }) {
    const { name, history, stateRoot } = item;
    // 1. 网页聊天记录
    if (enabled.has('history')) {
        hooks.onStage && hooks.onStage({ stage: '聊天记录', container: name });
        let text = JSON.stringify(includeSecrets ? history : redactHistory(history));
        if (scrubber) text = scrubber.scrub(text);
        await writer.addBuffer(`${prefix}/history.json`, `${text}\n`);
        for (const file of eventFilesFor(deps.webHistoryDir, name)) {
            const entryName = `${prefix}/${file.sub}/${file.file}`;
            if (scrubber) await addHostFileScrubbed(writer, file.full, entryName, { scrubber, tmpDir, stats });
            else await addHostFile(writer, file.full, entryName);
        }
    }
    // 2. 容器设置
    if (enabled.has('settings') && stateRoot) {
        hooks.onStage && hooks.onStage({ stage: '容器设置', container: name });
        const env = readSmallFileSafe(stateRoot.env, 256 * 1024);
        if (env) await writer.addBuffer(`${prefix}/state/env`, includeSecrets ? env : redactEnvText(env.toString('utf8')));
        for (const [file, label] of [[stateRoot.autostart, 'autostart.sh'], [stateRoot.systemPrompt, 'system-prompt.json'], [stateRoot.network, 'network.json'], [stateRoot.envFiles, 'env-files.json']]) {
            const body = readSmallFileSafe(file, 1024 * 1024);
            if (!body) continue;
            if (includeSecrets) await writer.addBuffer(`${prefix}/state/${label}`, body);
            else if (label === 'autostart.sh') await writer.addBuffer(`${prefix}/state/${label}`, scrubber.scrub(redact.redactCommandText(body.toString('utf8'))));
            else if (label === 'system-prompt.json') await writer.addBuffer(`${prefix}/state/${label}`, scrubber.scrub(body.toString('utf8')));
            else await writer.addBuffer(`${prefix}/state/${label}`, body);
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
}

// 4. 容器里的改动：只在读这部分数据期间暂停容器，读完立刻恢复
async function exportLayer({ writer, item, prefix, enabled, includeSecrets, scrubber, deps, hooks, stats, tmpDir, paused, warnings }) {
    const { name, info, diff } = item;
    const layerEnabled = LAYER_ITEM_IDS.filter(id => enabled.has(id));
    if (!info || !layerEnabled.length || !diff) return;
    hooks.onStage && hooks.onStage({ stage: '容器内数据', container: name });
    const mounts = info.mounts || [];
    const enabledSet = new Set(layerEnabled);
    const keep = abs => {
        const cls = plan.classifyLayerPath(abs, mounts);
        // 不带密钥时，各工具保存登录凭据的文件整份不带
        if (!includeSecrets && redact.isCredentialFile(abs)) {
            stats.skippedCredentialFiles = (stats.skippedCredentialFiles || 0) + 1;
            return false;
        }
        return cls !== null && enabledSet.has(cls) && diff.added.has(abs);
    };
    // 不带密钥：配置文件按字段清空，Agent 的文本文件里的密钥抹掉
    const rewrite = includeSecrets ? null : async (abs, meta, body, entryName, entryMeta) => {
        if (redact.isFieldRewriteFile(abs)) {
            // 太大没法按字段改写的配置文件宁可不带（原样带上会泄密）
            if (meta.size > 64 * 1024 * 1024) {
                stats.skippedCredentialFiles = (stats.skippedCredentialFiles || 0) + 1;
                return true;
            }
            const text = (await collectBytes(body, meta.size)).toString('utf8');
            const result = redact.redactFieldFile(abs, text);
            stats.scrubbedFiles = (stats.scrubbedFiles || 0) + 1;
            await writer.addBuffer(entryName, scrubber.scrub(result.text), entryMeta);
            return true;
        }
        const cls = plan.classifyLayerPath(abs, mounts);
        if (cls === 'agentSessions' || cls === 'agentExtras') {
            await addScrubbedStream({ writer, entryName, size: meta.size, iterable: body, meta: entryMeta, scrubber, tmpDir, stats });
            return true;
        }
        return false;
    };
    let pauseResult;
    try {
        pauseResult = await pauseForLayer({ item, deps, hooks, stats });
    } catch (error) {
        if (error.stillPaused) paused.add(name); // 收尾时再试一次恢复
        throw error;
    }
    const { pausedHere, warning } = pauseResult;
    if (warning) {
        warnings.push(warning);
        hooks.onWarning && hooks.onWarning(name, warning);
    }
    if (pausedHere) paused.add(name);
    try {
        for (const scope of plan.layerScopes(enabledSet, diff.added, diff.deleted, { mounts, parents: diff.parents })) {
            if (plan.classifyLayerPath(scope, mounts) === null) continue;
            await addContainerScope({ writer, runtime: deps.runtime, name, scope, prefix: `${prefix}/layer`, keep, rewrite, stats, hooks });
        }
    } finally {
        if (pausedHere) {
            // 读完（或出错）立刻恢复：恢复失败由调用方的收尾和任务记录兜底
            try {
                await deps.runtime.unpause(name);
                paused.delete(name);
                hooks.onUnpause && hooks.onUnpause(name);
            } catch (error) { /* 收尾时还会再试 */ }
        }
    }
    if (enabledSet.has('systemLayer')) {
        await writer.addBuffer(`${prefix}/layer-deleted.json`, `${JSON.stringify(diff.deleted)}\n`);
    }
}

// 一次做完（准备 + 写出）；网页走的是两段式，这个给测试和脚本用
async function exportArchive(options) {
    const prepared = await prepareExport(options);
    return writeExport(prepared, options);
}

module.exports = {
    ExportCancelled,
    TarWriter,
    exportArchive,
    prepareExport,
    writeExport,
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
