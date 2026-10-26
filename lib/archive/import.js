'use strict';

// 容器导入：边收边解包，不落临时包。归档可能来自别人，所有条目按不可信输入处理（见 safe-extract.js）。
// 顺序约定（导出端固定）：manifest.json 第一条 → 每个容器的 c/<idx>/… → w/<n>/… → END.json 最后一条。
// 容器在遇到它的第一个 layer/ 条目（或它的段落结束）时建好，layer/ 条目流式写进新容器；失败或取消时撤销本次导入建的一切。

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { once } = require('events');

const { readTarEntries, encodeEntryHeader, END_BLOCKS, pad } = require('./tar');
const { SafeExtractor, UnsafeEntryError, splitEntryPath } = require('./safe-extract');
const plan = require('./plan');

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

class ImportError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'ImportError';
        Object.assign(this, extra);
    }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

// 按文件头判断压缩格式并解压，返回可异步迭代的字节流
async function decompress(source) {
    const iterator = source[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    const chunks = [];
    while (head.length < 4) {
        const { value, done } = await iterator.next();
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        chunks.push(chunk);
        head = Buffer.concat([head, chunk]);
    }
    let transform;
    if (head.length >= 4 && head.subarray(0, 4).equals(ZSTD_MAGIC)) {
        if (typeof zlib.createZstdDecompress !== 'function') throw new ImportError('这个文件是 zstd 压缩的，当前 Node.js 版本不支持（需要 22.15 以上）');
        transform = zlib.createZstdDecompress();
    } else if (head.length >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC)) {
        transform = zlib.createGunzip();
    } else {
        throw new ImportError('不是 manyoyo 导出文件（不认识的压缩格式）');
    }
    transform.on('error', () => {});
    // 下游关了（导入失败 / 取消）就停止搬运，并让上游迭代器收尾，不留悬挂的等待
    const drained = () => new Promise((resolve, reject) => {
        const onDrain = () => { transform.removeListener('close', onClose); resolve(); };
        const onClose = () => { transform.removeListener('drain', onDrain); reject(new Error('解压流已关闭')); };
        transform.once('drain', onDrain);
        transform.once('close', onClose);
    });
    (async () => {
        try {
            for (const chunk of chunks) if (!transform.write(chunk)) await drained();
            for (;;) {
                const { value, done } = await iterator.next();
                if (done) break;
                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                if (!transform.write(chunk)) await drained();
            }
            transform.end();
        } catch (error) {
            if (iterator.return) iterator.return().catch(() => {});
            if (!transform.destroyed) transform.destroy(error);
        }
    })();
    return transform;
}

async function readAll(body, limit) {
    const parts = [];
    let size = 0;
    for await (const chunk of body) {
        size += chunk.length;
        if (size > limit) throw new ImportError('文件内容过大');
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') throw new ImportError('清单格式不对');
    if (manifest.format !== plan.FORMAT) throw new ImportError(`不支持的导出格式: ${manifest.format}`);
    if (!Array.isArray(manifest.containers) || manifest.containers.length === 0 || manifest.containers.length > 200) throw new ImportError('清单里没有容器');
    const seen = new Set();
    for (const item of manifest.containers) {
        if (!item || !Number.isInteger(item.idx) || item.idx < 0 || seen.has(item.idx)) throw new ImportError('清单里的容器序号不对');
        seen.add(item.idx);
        if (typeof item.name !== 'string' || !NAME_RE.test(item.name)) throw new ImportError(`清单里的容器名不合法: ${String(item.name).slice(0, 60)}`);
        if (item.work !== null && item.work !== undefined && !Number.isInteger(item.work)) throw new ImportError('清单里的工作目录编号不对');
    }
    const known = new Set(plan.ITEMS.map(item => item.id));
    if (!Array.isArray(manifest.items) || manifest.items.some(id => !known.has(id))) throw new ImportError('清单里的内容项不对');
    return manifest;
}

/**
 * 只读文件开头：返回清单。head 是文件开头（最多 4MB）。
 */
async function inspectArchiveHead(head) {
    const { Readable } = require('stream');
    const stream = await decompress(Readable.from([head]));
    try {
        for await (const { meta, body } of readTarEntries(stream, { maxEntrySize: MAX_MANIFEST_BYTES })) {
            if (meta.name !== 'manifest.json' || meta.type !== 'file') throw new ImportError('不是 manyoyo 导出文件（第一条不是清单）');
            const text = (await readAll(body, MAX_MANIFEST_BYTES)).toString('utf8');
            let manifest;
            try { manifest = JSON.parse(text); } catch (error) { throw new ImportError('清单不是合法的 JSON'); }
            return validateManifest(manifest);
        }
    } catch (error) {
        if (error instanceof ImportError) throw error;
        throw new ImportError(`读不出清单，文件可能不是 manyoyo 导出文件或已损坏（${error.message}）`);
    } finally {
        if (stream.destroy) stream.destroy();
    }
    throw new ImportError('文件里没有内容');
}

// 把容器名从 oldKey 换成 newKey：会话键是“容器名”或“容器名~agentId”
function renameSessionKey(key, oldName, newName) {
    if (key === oldName) return newName;
    if (typeof key === 'string' && key.startsWith(`${oldName}~`)) return `${newName}${key.slice(oldName.length)}`;
    return key;
}

async function rewriteEventFile(from, to, oldName, newName) {
    const input = fs.createReadStream(from, { encoding: 'utf8' });
    const output = fs.createWriteStream(to, { flags: 'wx', mode: 0o600 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch (error) { continue; }
            if (event && typeof event === 'object') {
                if (typeof event.aggregateId === 'string') event.aggregateId = renameSessionKey(event.aggregateId, oldName, newName);
                if (typeof event.sessionId === 'string') event.sessionId = renameSessionKey(event.sessionId, oldName, newName);
            }
            if (!output.write(`${JSON.stringify(event)}\n`)) await once(output, 'drain');
        }
    } finally {
        output.end();
        await once(output, 'close').catch(() => {});
    }
}

function rewriteProjection(text, oldName, newName) {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && typeof data.aggregateId === 'string') data.aggregateId = renameSessionKey(data.aggregateId, oldName, newName);
    return `${JSON.stringify(data)}\n`;
}

function isRealDir(p) {
    try { return fs.lstatSync(p).isDirectory(); } catch (error) { return false; }
}

function moveEntry(from, to) {
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

/**
 * 导入主流程。
 * options：
 *   source     原始上传流（压缩后的字节）
 *   plan       { containers: { [idx]: { name, hostPath, imageMode, confirm } } }（调用方已按清单校验过名字与路径）
 *   deps       { homeDir, webHistoryDir, runtime, createContainer, removeContainer, saveHistory, statfs?, containerState }
 *   job        container-jobs 的任务对象（check / addBytes / addCreated / update）
 */
async function importArchive(options) {
    const { source, deps, job } = options;
    const importPlan = options.plan || { containers: {} };
    const tmpRoot = path.join(deps.homeDir, '.manyoyo', 'tmp', `import-${job.id}`);
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    job.addCreated('dirs', tmpRoot);
    const cTree = path.join(tmpRoot, 'c');
    fs.mkdirSync(cTree, { mode: 0o700 });

    let free = Infinity;
    try {
        const stat = (deps.statfs || fs.statfsSync)(tmpRoot);
        free = Number(stat.bavail) * Number(stat.bsize);
    } catch (error) { /* 取不到就只靠过程中的监控 */ }
    const maxBytes = options.maxBytes || (Number.isFinite(free) ? Math.max(0, free - 1024 * 1024 * 1024) : Infinity);

    const cExtractor = new SafeExtractor(cTree, { maxBytes });
    const workExtractors = new Map();
    const state = {
        manifest: null,
        entries: 0,
        sawEnd: false,
        containers: new Map(), // idx -> { created, info, layer, mounts, swallowed }
        destDirs: new Map(), // work n -> { dest, createdByUs, moved: [] }
        layerLinks: new Set(),
        stats: { layerFiles: 0, layerDropped: 0, layerSkippedSystem: 0, skippedLinks: 0 }
    };

    let manifestIndex = null;
    const manifestByIdx = () => {
        if (!manifestIndex) manifestIndex = new Map(state.manifest.containers.map(item => [item.idx, item]));
        return manifestIndex;
    };

    // 工作目录的目的地：容器创建前先建好空目录（容器要挂载它）；已存在且非空直接拒绝
    function prepareDest(n, dest) {
        if (state.destDirs.has(n)) {
            if (state.destDirs.get(n).dest !== dest) throw new ImportError('共用同一个工作目录的容器必须导入到同一个位置');
            return;
        }
        // 不同的工作目录不能落到同一个位置（会互相覆盖）
        for (const [otherN, info] of state.destDirs) {
            if (otherN !== n && info.dest === dest) throw new ImportError(`不同的工作目录不能导入到同一个位置: ${dest}`);
        }
        let createdByUs = false;
        if (fs.existsSync(dest)) {
            if (!isRealDir(dest) || fs.readdirSync(dest).length > 0) throw new ImportError(`工作目录已存在且不为空: ${dest}`);
        } else {
            fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
            createdByUs = true;
            job.addCreated('dirs', dest);
        }
        state.destDirs.set(n, { dest, createdByUs, moved: [] });
    }

    async function ensureContainer(idx) {
        let entry = state.containers.get(idx);
        if (entry && entry.created) return entry;
        const manifestItem = manifestByIdx().get(idx);
        const chosen = importPlan.containers[idx];
        entry = entry || { created: false };
        state.containers.set(idx, entry);
        const base = path.join(cTree, String(idx));
        let history = {};
        const historyFile = path.join(base, 'history.json');
        if (fs.existsSync(historyFile)) {
            const text = fs.readFileSync(historyFile, 'utf8');
            if (text.length > MAX_JSON_BYTES) throw new ImportError('历史记录文件过大');
            try { history = JSON.parse(text); } catch (error) { throw new ImportError(`历史记录不是合法的 JSON（${manifestItem.name}）`); }
        }
        const stateFiles = {};
        for (const file of ['env', 'autostart.sh', 'system-prompt.json', 'network.json', 'env-files.json']) {
            const full = path.join(base, 'state', file);
            if (fs.existsSync(full)) {
                const stat = fs.lstatSync(full);
                if (stat.isFile() && stat.size <= 1024 * 1024) stateFiles[file] = fs.readFileSync(full, 'utf8');
            }
        }
        if (manifestItem.work !== null && manifestItem.work !== undefined) prepareDest(manifestItem.work, chosen.hostPath);
        if (job.container !== chosen.name || job.stage !== '创建容器') job.update({ stage: '创建容器', container: chosen.name });
        const hasSessions = state.manifest.items.includes('agentSessions');
        // 先登记历史文件：建容器过程中一旦失败，撤销时也能把它删掉
        job.addCreated('historyFiles', path.join(deps.webHistoryDir, `${chosen.name}.json`));
        const created = await deps.createContainer({
            onCreated: (name, id) => job.addCreated('containers', { name, id }),
            idx,
            oldName: manifestItem.name,
            newName: chosen.name,
            history,
            stateFiles,
            hostPath: chosen.hostPath,
            imageMode: chosen.imageMode === 'default' ? 'default' : 'same',
            confirm: chosen.confirm || {},
            hasSessions,
            manifestItem
        });
        if (!job.created.containers.some(item => item.name === created.containerName)) job.addCreated('containers', { name: created.containerName, id: created.id });
        entry.created = created;
        entry.mounts = [];
        try {
            const info = deps.runtime.inspect(created.containerName);
            entry.mounts = info ? info.mounts : [];
            entry.sameImage = Boolean(info) && info.image === manifestItem.image;
        } catch (error) { entry.sameImage = false; }
        // 事件日志、投影：改名后写进历史目录
        await restoreHistoryFiles(idx, manifestItem.name, created.containerName, history, hasSessions);
        // 聊天图片、回退快照
        for (const dir of ['uploads', 'snap.git']) {
            const from = path.join(base, 'box', dir);
            if (isRealDir(from) && created.paths && created.paths.box) {
                const to = path.join(created.paths.box, dir);
                fs.rmSync(to, { recursive: true, force: true });
                moveEntry(from, to);
            }
        }
        return entry;
    }

    async function restoreHistoryFiles(idx, oldName, newName, history, hasSessions) {
        const base = path.join(cTree, String(idx));
        for (const sub of ['events', 'projections']) {
            const dir = path.join(base, sub);
            if (!isRealDir(dir)) continue;
            const targetDir = path.join(deps.webHistoryDir, sub);
            fs.mkdirSync(targetDir, { recursive: true });
            for (const file of fs.readdirSync(dir)) {
                const decoded = (() => { try { return decodeURIComponent(file.replace(/\.jsonl?$/, '')); } catch (error) { return null; } })();
                if (decoded === null || (decoded !== oldName && !decoded.startsWith(`${oldName}~`))) continue;
                const newFile = `${encodeURIComponent(renameSessionKey(decoded, oldName, newName))}${path.extname(file)}`;
                const to = path.join(targetDir, newFile);
                if (fs.existsSync(to)) throw new ImportError(`目标已有同名事件文件: ${newFile}`);
                job.addCreated('historyFiles', to);
                if (sub === 'events') await rewriteEventFile(path.join(dir, file), to, oldName, newName);
                else fs.writeFileSync(to, rewriteProjection(fs.readFileSync(path.join(dir, file), 'utf8'), oldName, newName), { flag: 'wx', mode: 0o600 });
            }
        }
        await deps.saveHistory(newName, history, { oldName, hasSessions });
    }

    async function finishContainer(idx) {
        const entry = state.containers.get(idx);
        if (!entry) return;
        await ensureContainer(idx);
        if (entry.layer) {
            entry.layer.stdin.write(END_BLOCKS);
            entry.layer.stdin.end();
            const result = await entry.layer.done;
            entry.layer = null;
            if (result.code !== 0) throw new ImportError(`写入容器失败: ${String(result.stderr || '').trim().slice(0, 200)}`);
        }
    }

    async function writeLayerEntry(idx, meta, body, rest) {
        const entry = await ensureContainer(idx);
        const abs = plan.normalizeContainerPath(`/${rest}`);
        const mounts = entry.mounts || [];
        const drop = async () => { state.stats.layerDropped += 1; for await (const piece of body) void piece; };
        let segments;
        try { segments = splitEntryPath(rest); } catch (error) { return drop(); }
        if (!abs) return drop();
        const cls = plan.classifyLayerPath(abs, mounts);
        if (cls === null) return drop();
        if (cls === 'systemLayer' && !entry.sameImage) {
            state.stats.layerSkippedSystem += 1;
            return drop();
        }
        // 经过本归档里出现过的符号链接的路径不写（否则能借链接绕到挂载点）
        for (let i = 1; i < segments.length; i++) {
            if (state.layerLinks.has(`${entry.created.containerName}:/${segments.slice(0, i).join('/')}`)) return drop();
        }
        if (meta.type === 'symlink') {
            const target = meta.linkname.startsWith('/') ? meta.linkname : path.posix.join(path.posix.dirname(abs), meta.linkname);
            const resolved = plan.normalizeContainerPath(target.startsWith('/') ? target : `/${target}`);
            if (!resolved || plan.classifyLayerPath(resolved, mounts) === null) return drop();
            state.layerLinks.add(`${entry.created.containerName}:${abs}`);
        } else if (meta.type !== 'file' && meta.type !== 'dir') {
            return drop();
        }
        if (!entry.layer) {
            entry.layer = deps.runtime.cpIn(entry.created.containerName, '/');
            entry.layer.stdin.on('error', () => {});
        }
        const stdin = entry.layer.stdin;
        const write = async buffer => {
            job.addBytes(buffer.length);
            if (!stdin.write(buffer)) await once(stdin, 'drain');
        };
        await write(encodeEntryHeader({ name: segments.join('/'), type: meta.type, size: meta.size, mode: meta.mode, mtime: meta.mtime, linkname: meta.linkname }));
        if (meta.type === 'file') {
            for await (const chunk of body) await write(chunk);
            const padding = pad(meta.size);
            if (padding) await write(Buffer.alloc(padding));
            state.stats.layerFiles += 1;
        }
    }

    async function routeEntry(meta, body) {
        const name = meta.name;
        if (meta.type === 'hardlink' || meta.type === 'other') throw new UnsafeEntryError(`归档里有不允许的条目类型（${meta.type}）: ${name}`);
        // 不管最后是不是要这个条目，路径先过一遍：绝对路径、.. 等一律拒绝，而不是悄悄略过
        splitEntryPath(name);
        let m;
        if ((m = /^c\/(\d+)\/layer\/(.+)$/.exec(name))) {
            const idx = Number(m[1]);
            if (!manifestByIdx().has(idx)) throw new ImportError(`归档里有清单没列出的容器: ${idx}`);
            if (!importPlan.containers[idx]) { for await (const piece of body) void piece; return idx; }
            await writeLayerEntry(idx, meta, body, m[2]);
            return idx;
        }
        if ((m = /^c\/(\d+)(?:\/(.*))?$/.exec(name))) {
            const idx = Number(m[1]);
            if (!manifestByIdx().has(idx)) throw new ImportError(`归档里有清单没列出的容器: ${idx}`);
            if (!importPlan.containers[idx]) { for await (const piece of body) void piece; return idx; }
            if (!state.containers.has(idx)) state.containers.set(idx, { created: false });
            await extractInto(cExtractor, { ...meta, name: name.slice(2) }, body);
            return idx;
        }
        if ((m = /^w\/(\d+)(?:\/(.*))?$/.exec(name))) {
            const n = Number(m[1]);
            if (!state.destDirs.has(n)) { for await (const piece of body) void piece; return null; }
            let extractor = workExtractors.get(n);
            if (!extractor) {
                const dir = path.join(tmpRoot, 'w', String(n));
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                extractor = new SafeExtractor(dir, { maxBytes });
                workExtractors.set(n, extractor);
            }
            await extractInto(extractor, { ...meta, name: m[2] || '' }, body, m[2] === undefined);
            return null;
        }
        throw new UnsafeEntryError(`归档里有不认识的路径: ${name}`);
    }

    async function extractInto(extractor, meta, body, isRoot = false) {
        if (isRoot) { for await (const piece of body) void piece; return; }
        if (meta.type === 'dir') {
            extractor.addDir(meta.name, meta.mode);
        } else if (meta.type === 'symlink') {
            extractor.addSymlink(meta.name, meta.linkname);
            // c/ 里的链接永远不创建（下面只对工作目录 finalize）
        } else {
            await extractor.addFile(meta.name, meta.mode, body, meta.size);
            job.addBytes(meta.size);
        }
    }

    async function undo() {
        for (const created of [...(job.created.containers || [])].reverse()) {
            try { await deps.removeContainer(created.name, created.id); } catch (error) { /* 宁可删不掉 */ }
        }
        for (const file of job.created.historyFiles || []) fs.rmSync(file, { force: true });
        for (const info of state.destDirs.values()) {
            if (info.createdByUs) fs.rmSync(info.dest, { recursive: true, force: true });
            else for (const name of info.moved) fs.rmSync(path.join(info.dest, name), { recursive: true, force: true });
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    let stream = null;
    try {
        job.update({ stage: '读取清单' });
        stream = await decompress(source);
        let currentIdx = null;
        for await (const { meta, body } of readTarEntries(stream)) {
            job.check();
            state.entries += 1;
            if (state.entries === 1) {
                if (meta.name !== 'manifest.json' || meta.type !== 'file') throw new ImportError('不是 manyoyo 导出文件（第一条不是清单）');
                const text = (await readAll(body, MAX_MANIFEST_BYTES)).toString('utf8');
                try { state.manifest = validateManifest(JSON.parse(text)); } catch (error) {
                    throw error instanceof ImportError ? error : new ImportError('清单不是合法的 JSON');
                }
                for (const item of state.manifest.containers) {
                    if (importPlan.containers[item.idx] && !NAME_RE.test(String(importPlan.containers[item.idx].name))) throw new ImportError(`导入后的容器名不合法: ${importPlan.containers[item.idx].name}`);
                }
                continue;
            }
            if (state.sawEnd) throw new ImportError('归档在结束标记之后还有内容');
            if (meta.name === 'END.json') {
                const end = JSON.parse((await readAll(body, 1024 * 1024)).toString('utf8'));
                if (!end || end.entries !== state.entries) throw new ImportError('归档条目数与结束标记不符，文件不完整');
                state.sawEnd = true;
                continue;
            }
            const idx = await routeEntry(meta, body);
            if (currentIdx !== null && idx !== currentIdx) await finishContainer(currentIdx);
            currentIdx = idx === undefined ? currentIdx : idx;
            const shown = idx !== null && idx !== undefined && importPlan.containers[idx] ? importPlan.containers[idx].name : job.container;
            if (shown !== job.container) job.update({ container: shown });
        }
        if (!state.sawEnd) throw new ImportError('文件不完整（缺少结束标记），可能上传被中断');
        if (currentIdx !== null) await finishContainer(currentIdx);
        for (const idx of Object.keys(importPlan.containers).map(Number)) {
            if (manifestByIdx().has(idx)) await finishContainer(idx);
        }
        // 工作目录：符号链接最后创建，然后把内容搬到目的地
        job.update({ stage: '放置工作目录' });
        for (const [n, extractor] of workExtractors) {
            state.stats.skippedLinks += extractor.skippedLinks;
            extractor.finalizeSymlinks();
            state.stats.skippedLinks += extractor.skippedLinks;
            const info = state.destDirs.get(n);
            for (const name of fs.readdirSync(extractor.root)) {
                moveEntry(path.join(extractor.root, name), path.join(info.dest, name));
                info.moved.push(name);
            }
        }
        const result = {
            containers: [...state.containers.values()].filter(item => item.created).map(item => item.created.containerName),
            stats: state.stats
        };
        // 成功：不再需要撤销记录
        job.update({ created: { containers: [], dirs: [], historyFiles: [] } });
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        return result;
    } catch (error) {
        for (const entry of state.containers.values()) {
            if (entry.layer) { try { entry.layer.kill && entry.layer.kill(); } catch (e) { /* ignore */ } }
        }
        // 释放解压流；上传流（req）不能销毁，否则收不到错误响应，由调用方丢弃剩余内容
        if (stream && !stream.destroyed) stream.destroy();
        if (source && source.path !== undefined && typeof source.destroy === 'function') source.destroy();
        await undo();
        throw error;
    }
}

module.exports = {
    ImportError,
    importArchive,
    inspectArchiveHead,
    decompress,
    renameSessionKey,
    validateManifest,
    NAME_RE
};
