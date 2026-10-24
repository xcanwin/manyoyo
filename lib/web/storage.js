'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 磁盘占用页：宿主机上的工作目录（容器删了也会留下）和已删除容器的对话历史。
// 全部异步，不阻塞事件循环；只读，删除只允许 work/ 下没人用的直接子目录。

const SIZE_TIMEOUT_MS = 120000;
const SIZE_CACHE_MS = 60000;
const LIST_DIR_LIMIT = 500;
// MANYOYO 创建的工作目录名（快捷对话 / 向导的时间戳目录）；工作目录根里别的东西不当作自己的
const MANAGED_NAME = /^\d{8}-\d{6}$/;
const historyCache = new Map();
const sizeCache = new Map();

async function safeRealpath(target) {
    try {
        return await fs.promises.realpath(target);
    } catch (e) {
        return path.resolve(target);
    }
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 运行时里的容器：名字 → 状态，和每个容器挂载的宿主机路径。运行时不可用时抛错（调用方据此拒绝删除）。 */
async function readContainers(dockerExecAsync) {
    const psOutput = String(await dockerExecAsync(['ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeout: 15000 }) || '');
    const states = new Map();
    for (const line of psOutput.split('\n')) {
        const [name, state] = line.split('\t').map(part => (part || '').trim());
        if (name) states.set(name, state === 'running' ? 'running' : 'stopped');
    }
    const mounts = new Map();
    if (states.size) {
        const inspectOutput = String(await dockerExecAsync(
            ['inspect', '-f', '{{.Name}}{{range .Mounts}}{{if eq .Type "bind"}}\t{{.Source}}{{end}}{{end}}', ...states.keys()],
            { timeout: 20000 }
        ) || '');
        for (const line of inspectOutput.split('\n')) {
            const [rawName, ...sources] = line.split('\t');
            const name = String(rawName || '').replace(/^\//, '').trim();
            if (name) mounts.set(name, sources.map(item => item.trim()).filter(Boolean));
        }
    }
    return { states, mounts };
}

/** 每个会话历史文件里记的 hostPath；按 ino/mtime/size 缓存，没变的文件不重新解析 */
async function readHistoryEntries(historyDir) {
    let files;
    try {
        files = (await fs.promises.readdir(historyDir)).filter(file => file.endsWith('.json'));
    } catch (e) {
        return [];
    }
    const entries = [];
    for (const file of files) {
        const filePath = path.join(historyDir, file);
        const name = path.basename(file, '.json');
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
        } catch (e) {
            continue;
        }
        const sig = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
        let cached = historyCache.get(filePath);
        if (!cached || cached.sig !== sig) {
            let hostPath = '';
            try {
                const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
                const applied = parsed && parsed.applied && typeof parsed.applied === 'object' ? parsed.applied : {};
                const snapshot = parsed && parsed.runtimeSnapshot && typeof parsed.runtimeSnapshot === 'object' ? parsed.runtimeSnapshot : {};
                hostPath = String(applied.hostPath || snapshot.hostPath || '');
            } catch (e) { /* 损坏的历史当没有路径 */ }
            cached = { sig, hostPath };
            historyCache.set(filePath, cached);
        }
        entries.push({ name, hostPath: cached.hostPath, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
    return entries;
}

/** 某个会话名对应的事件日志 / 投影文件（name.jsonl、name~agent.jsonl） */
async function listEventFiles(historyDir, name) {
    const found = [];
    for (const sub of ['events', 'projections']) {
        let files = [];
        try {
            files = await fs.promises.readdir(path.join(historyDir, sub));
        } catch (e) { /* 目录可能不存在 */ }
        for (const file of files) {
            const base = file.replace(/\.(jsonl|json)$/, '');
            if (base === name || base.startsWith(`${name}~`)) found.push(path.join(historyDir, sub, file));
        }
    }
    return found;
}

// events/ 与 projections/ 各读一次，再按会话名分组累加（不要每份历史都重新 readdir）
async function eventBytesByName(historyDir) {
    const totals = new Map();
    for (const sub of ['events', 'projections']) {
        let files = [];
        try {
            files = await fs.promises.readdir(path.join(historyDir, sub));
        } catch (e) { /* 目录可能不存在 */ }
        for (const file of files) {
            const base = file.replace(/\.(jsonl|json)$/, '');
            const name = base.split('~')[0];
            try {
                totals.set(name, (totals.get(name) || 0) + (await fs.promises.stat(path.join(historyDir, sub, file))).size);
            } catch (e) { /* 忽略 */ }
        }
    }
    return totals;
}

// workRoots 是 MANYOYO 自己的默认根；extraWorkRoots 来自用户配置（快捷对话目录），
// 先过一遍：必须是绝对路径，且不能是 / 或 $HOME 及其上级（配得太宽会把用户自己的时间戳目录当成自己的）
async function resolveRoots({ workRoots, extraWorkRoots = [], homeDir = '' }) {
    const workReals = new Set();
    const extraReals = new Set();
    for (const root of workRoots) workReals.add(await safeRealpath(root));
    const homeReal = homeDir ? await safeRealpath(homeDir) : '';
    for (const root of extraWorkRoots) {
        if (!path.isAbsolute(root)) continue;
        const real = await safeRealpath(root);
        if (real === path.parse(real).root || (homeReal && isInside(real, homeReal))) continue;
        if (!workReals.has(real)) extraReals.add(real);
    }
    for (const real of extraReals) workReals.add(real);
    return { workReals, extraReals };
}

/**
 * 目录列表：以“宿主机目录”为一行（同名容器换路径、同路径多个容器都不会乱）。
 * 来源：work/ 下的子目录 ∪ 历史里记的 hostPath；容器挂载只用来判断“有人在用”。
 */
async function buildStorageListing({ workRoots, extraWorkRoots = [], homeDir = '', historyDir, dockerExecAsync }) {
    const { states, mounts } = await readContainers(dockerExecAsync);
    const history = await readHistoryEntries(historyDir);
    const { workReals, extraReals } = await resolveRoots({ workRoots, extraWorkRoots, homeDir });
    // 专用目录：里面（不算点开头的文件）全是时间戳目录，说明这个目录就是拿来放 MANYOYO 工作目录的，
    // 里面没有历史记录的时间戳目录（历史被清理过、或旧版本建的）也算自己的；混着别的东西（如 ~/Downloads）的不算
    const dedicatedExtras = new Set();
    for (const real of extraReals) {
        try {
            const entries = (await fs.promises.readdir(real, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.'));
            if (entries.length > 0 && entries.every(entry => entry.isDirectory() && MANAGED_NAME.test(entry.name))) dedicatedExtras.add(real);
        } catch (e) { /* 读不了就不算专用 */ }
    }
    const historyPaths = new Set();

    const liveMountPaths = [];
    for (const [name, sources] of mounts) {
        for (const source of sources) liveMountPaths.push({ name, source: await safeRealpath(source) });
    }

    const rows = new Map();
    const ensureRow = async (rawPath) => {
        const real = await safeRealpath(rawPath);
        let row = rows.get(real);
        if (!row) {
            row = { path: real, sessions: [], managed: false };
            rows.set(real, row);
        }
        return row;
    };

    for (const root of workReals) {
        try {
            for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
                if (entry.isDirectory() && MANAGED_NAME.test(entry.name)) await ensureRow(path.join(root, entry.name));
            }
        } catch (e) { /* work 目录还不存在 */ }
    }

    for (const item of history) {
        if (!item.hostPath || !path.isAbsolute(item.hostPath)) continue;
        try {
            if (!(await fs.promises.stat(item.hostPath)).isDirectory()) continue;
        } catch (e) {
            continue;
        }
        const row = await ensureRow(item.hostPath);
        historyPaths.add(row.path);
        // 容器还在时，历史里记的路径可能是“上一代同名容器”留下的，以容器真实挂载为准（下面的 holders）；
        // 只有查不到它的挂载时才退回历史，宁可当成在用
        if (states.has(item.name) && (mounts.get(item.name) || []).length > 0) continue;
        row.sessions.push({ name: item.name, state: states.get(item.name) || 'deleted' });
    }

    const result = [];
    for (const row of rows.values()) {
        const parent = path.dirname(row.path);
        // 用户配置的目录下，只有历史里记过的才算 MANYOYO 的；默认根下按名字认
        row.managed = workReals.has(parent) && MANAGED_NAME.test(path.basename(row.path)) &&
            (!extraReals.has(parent) || dedicatedExtras.has(parent) || historyPaths.has(row.path));
        // 容器没有历史（命令行建的）或历史里没记路径时，用挂载关系补上。
        // 只认“挂的就是这个目录或它里面的子目录”：挂了上级目录（比如整个 /root）的容器删掉这个目录也不会坏，不算在用
        const holders = new Set(liveMountPaths
            .filter(item => isInside(row.path, item.source) || (row.managed && item.source === parent))
            .map(item => item.name));
        for (const name of holders) {
            if (!row.sessions.some(item => item.name === name)) row.sessions.push({ name, state: states.get(name) || 'stopped' });
        }
        const inUse = holders.size > 0 || row.sessions.some(item => item.state !== 'deleted');
        let stat = null;
        let empty = false;
        try {
            stat = await fs.promises.stat(row.path);
            empty = (await fs.promises.readdir(row.path)).length === 0;
        } catch (e) {
            continue;
        }
        result.push({
            path: row.path,
            managed: row.managed,
            status: inUse ? 'in-use' : (row.sessions.length ? 'history-only' : 'unused'),
            sessions: row.sessions.sort((a, b) => a.name.localeCompare(b.name)),
            mtimeMs: stat.mtimeMs,
            empty,
            deletable: row.managed && !inUse
        });
    }
    result.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const deletedHistories = [];
    const eventBytes = await eventBytesByName(historyDir);
    for (const item of history) {
        if (states.has(item.name)) continue;
        deletedHistories.push({ name: item.name, bytes: item.bytes + (eventBytes.get(item.name) || 0), updatedAt: new Date(item.mtimeMs).toISOString() });
    }
    deletedHistories.sort((a, b) => b.bytes - a.bytes);
    return { rows: result, deletedHistories, workRoots: Array.from(workReals) };
}

// du 很慢：同一目录的并发请求合并成一个，全局最多同时跑 DU_MAX_PARALLEL 个，多开几个标签页也不会把磁盘打满
const DU_MAX_PARALLEL = 2;
const duInFlight = new Map();
const duWaiting = [];
let duRunning = 0;

function acquireDu() {
    if (duRunning < DU_MAX_PARALLEL) {
        duRunning += 1;
        return Promise.resolve();
    }
    return new Promise(resolve => duWaiting.push(resolve));
}

function releaseDu() {
    const next = duWaiting.shift();
    if (next) next();
    else duRunning -= 1;
}

/** `du -sk`：真实占用（含目录本身）；超时就杀掉并返回 timedOut */
function directorySize(dir, options = {}) {
    const hit = sizeCache.get(dir);
    if (hit && Date.now() - hit.at < SIZE_CACHE_MS) return Promise.resolve(hit.value);
    if (duInFlight.has(dir)) return duInFlight.get(dir);
    const promise = acquireDu().then(() => runDu(dir, options)).finally(() => {
        releaseDu();
        duInFlight.delete(dir);
    });
    duInFlight.set(dir, promise);
    return promise;
}

function runDu(dir, { timeoutMs = SIZE_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        let output = '';
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!value.timedOut && !value.error) sizeCache.set(dir, { at: Date.now(), value });
            resolve(value);
        };
        const child = spawn('du', ['-sk', '-x', '--', dir], { stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ timedOut: true });
        }, timeoutMs);
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', () => finish({ error: true }));
        child.on('close', () => {
            const kb = Number(String(output).trim().split(/\s+/)[0]);
            finish(Number.isFinite(kb) ? { bytes: kb * 1024 } : { error: true });
        });
    });
}

/** 只读列出已知目录里的内容：sub 是相对路径，realpath 之后必须仍在目录内（挡 .. 和符号链接逃逸） */
async function listDirectory(root, sub) {
    let rootReal;
    let target;
    try {
        rootReal = await fs.promises.realpath(root);
        // 路径不存在就直接 404，不退回字面路径（否则检查之后被换成符号链接就能逃出去）
        target = await fs.promises.realpath(path.join(rootReal, String(sub || '')));
    } catch (e) {
        return { ok: false, status: 404, error: '目录不存在或无法读取' };
    }
    if (!isInside(rootReal, target)) return { ok: false, status: 400, error: '路径超出范围' };
    let names;
    try {
        names = await fs.promises.readdir(target, { withFileTypes: true });
        // 读完再确认一次：容器能写这些目录，检查和读取之间可能被换成指向别处的符号链接
        if ((await fs.promises.realpath(target)) !== target) return { ok: false, status: 400, error: '路径超出范围' };
    } catch (e) {
        return { ok: false, status: 404, error: '目录不存在或无法读取' };
    }
    const entries = [];
    for (const entry of names.slice(0, LIST_DIR_LIMIT)) {
        let stat = null;
        try {
            stat = await fs.promises.lstat(path.join(target, entry.name));
        } catch (e) { /* 忽略 */ }
        entries.push({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : (entry.isSymbolicLink() ? 'link' : 'file'),
            size: stat && !entry.isDirectory() ? stat.size : null,
            mtimeMs: stat ? stat.mtimeMs : null
        });
    }
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return { ok: true, path: target, relative: path.relative(rootReal, target), entries, truncated: names.length > LIST_DIR_LIMIT };
}

/**
 * 删除 work/ 下没人用的子目录；每次删之前重新算一遍列表，不信前端传来的状态。
 * emptyOnly：只删空目录（rmdir，非空会失败，不会递归删除），批量清理空目录用
 */
async function removeManagedDirectory(listing, targetPath, { emptyOnly = false } = {}) {
    const row = listing.rows.find(item => item.path === targetPath);
    if (!row) return { ok: false, status: 404, error: '没有这个目录，请刷新列表' };
    if (!row.deletable) return { ok: false, status: 409, error: row.managed ? '这个目录还有容器在用' : '只能删除 MANYOYO 自己创建的工作目录' };
    if (emptyOnly) {
        try {
            await fs.promises.rmdir(row.path);
        } catch (e) {
            return { ok: false, status: 409, error: e && e.code === 'ENOTEMPTY' ? '目录不是空的' : '删除失败' };
        }
    } else {
        await fs.promises.rm(row.path, { recursive: true, force: true });
    }
    sizeCache.delete(row.path);
    return { ok: true };
}

/**
 * 删除容器后顺手清掉它的空工作目录：必须在工作目录根里、名字是时间戳、没有容器挂它、而且是空的。
 * 只用 rmdir（非空会失败），所以不会删到任何文件。尽力而为，返回是否删除了
 */
async function removeEmptyWorkDir({ hostPath, workRoots, extraWorkRoots, homeDir, dockerExecAsync }) {
    if (!hostPath || !path.isAbsolute(hostPath)) return false;
    let real;
    try {
        real = await fs.promises.realpath(hostPath);
    } catch (e) {
        return false;
    }
    const { workReals } = await resolveRoots({ workRoots, extraWorkRoots, homeDir });
    const parent = path.dirname(real);
    if (!workReals.has(parent) || !MANAGED_NAME.test(path.basename(real))) return false;
    try {
        const { mounts } = await readContainers(dockerExecAsync);
        for (const sources of mounts.values()) {
            for (const source of sources) {
                const sourceReal = await safeRealpath(source);
                if (isInside(real, sourceReal) || sourceReal === parent) return false;
            }
        }
        await fs.promises.rmdir(real);
        return true;
    } catch (e) {
        return false;
    }
}

// removeHistoryFile 由调用方传入（server 里的 removeWebSessionHistory，会同时清掉进程内缓存）
async function removeDeletedHistory(historyDir, listing, name, removeHistoryFile) {
    if (!listing.deletedHistories.some(item => item.name === name)) return { ok: false, status: 404, error: '没有这份历史，或它的容器还在' };
    removeHistoryFile(name);
    for (const file of await listEventFiles(historyDir, name)) {
        await fs.promises.rm(file, { force: true });
    }
    return { ok: true };
}

module.exports = {
    buildStorageListing,
    directorySize,
    listDirectory,
    removeManagedDirectory,
    removeEmptyWorkDir,
    removeDeletedHistory,
    readContainers
};
