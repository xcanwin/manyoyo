'use strict';

// 容器导出 / 导入的 HTTP 接口。全部在全局认证网关之后，非 GET 请求已由 handleWebApi 校验 X-Requested-With。
// 核心逻辑在 lib/archive/，这里只做：参数校验、任务登记、把请求 / 响应接到流上、把 server.js 里的建容器能力包成 deps。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const plan = require('../archive/plan');
const { exportArchive, archiveFileName, zstdAvailable } = require('../archive/export');
const { importArchive, inspectArchiveHead, ImportError, NAME_RE } = require('../archive/import');
const { buildImportCreateOptions } = require('../archive/risks');
const { createCliRuntime } = require('../archive/runtime');
const { JobCancelled } = require('./container-jobs');
const { parseEnvEntry } = require('../runtime-normalizers');

const FILE_RE = /^manyoyo-export-\d{8}-\d{6}\.tar\.(zst|gz)$/;
const HEAD_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_WAIT_MS = 2 * 60 * 1000;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_CONTAINERS = 50;
const MAX_PLAN_BYTES = 64 * 1024;

function httpError(status, message, extra = {}) {
    return Object.assign(new Error(message), { statusCode: status, ...extra });
}

function exportsDirOf(homeDir) {
    return path.join(homeDir, '.manyoyo', 'exports');
}

function freeBytes(dir, statfs = fs.statfsSync) {
    try {
        let probe = dir;
        while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
        const stat = statfs(probe);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch (error) {
        return null;
    }
}

function duBytes(dir, timeoutMs = 5000) {
    return new Promise(resolve => {
        execFile('du', ['-sk', '--', dir], { timeout: timeoutMs }, (error, stdout) => {
            if (error) return resolve(null);
            const kb = Number(String(stdout).split(/\s+/)[0]);
            resolve(Number.isFinite(kb) ? kb * 1024 : null);
        });
    });
}

function readHead(file, bytes) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw httpError(400, '不是普通文件');
        const buffer = Buffer.alloc(Math.min(bytes, stat.size));
        let offset = 0;
        while (offset < buffer.length) {
            const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (n === 0) break;
            offset += n;
        }
        return buffer.subarray(0, offset);
    } finally {
        fs.closeSync(fd);
    }
}

async function readRequestHead(req, limit) {
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw httpError(413, '这一段超过了 4MB，不是 manyoyo 导出文件的开头');
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}

function createTransferRoutes({ ctx, state, req, res, deps }) {
    const { sendJson, readJsonBody } = deps;
    const homeDir = ctx.homeDir || os.homedir();
    const exportsDir = exportsDirOf(homeDir);
    const registry = state.jobs;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtime = ctx.transferRuntime || createCliRuntime({ command: ctx.dockerCmd || 'docker', env: ctx.dockerEnv });

    function fail(error, fallback = 400) {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendJson(res, error.statusCode || fallback, { error: error.message || '操作失败', ...(error.busy ? { busy: error.busy, jobId: error.jobId } : {}) });
    }

    function validateContainerNames(list) {
        if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CONTAINERS) throw httpError(400, `containers 需要 1 到 ${MAX_CONTAINERS} 个容器名`);
        const names = [...new Set(list.map(String))];
        for (const name of names) {
            if (!ctx.isValidContainerName(name)) throw httpError(400, `容器名不合法: ${name}`);
            if (!ctx.containerExists(name) && !deps.historyExists(name)) throw httpError(404, `找不到容器: ${name}`);
            const busy = registry.busyFor(name);
            if (busy) throw httpError(409, busy.type === 'export' ? '这个容器正在导出' : '这个容器正在导入', { busy: busy.type, jobId: busy.id });
            if (state.agentRuns && state.agentRuns.get(name)) throw httpError(409, `容器 ${name} 里有 AGENT 正在执行，请等它结束或先停止再导出`);
        }
        return names;
    }

    function ensureExportsDir() {
        fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
    }

    function exportDeps() {
        return {
            homeDir,
            webHistoryDir: state.webHistoryDir,
            runtime,
            containerState: deps.containerState,
            version: deps.version,
            loadHistory: name => deps.loadHistory(name)
        };
    }

    function exportHooks(job, diskGuard) {
        let sinceCheck = 0;
        return {
            check: () => job.check(),
            onBytes: n => {
                job.addBytes(n);
                sinceCheck += n;
                if (diskGuard && sinceCheck >= 64 * 1024 * 1024) {
                    sinceCheck = 0;
                    const free = freeBytes(exportsDir, ctx.statfsSync);
                    if (free !== null && free < MIN_FREE_BYTES) throw httpError(507, '服务器磁盘空间不足，导出已中止');
                }
            },
            onStage: info => job.update({ stage: info.stage, container: info.container }),
            onPause: (name, info, how) => job.addPaused(name, info.id, how),
            onUnpause: name => job.removePaused(name)
        };
    }

    async function runExport(job, out, options) {
        try {
            const result = await exportArchive({
                out,
                containers: job.containers.map(name => ({ name })),
                items: options.items,
                includeSecrets: options.includeSecrets,
                compression: options.compression,
                deps: exportDeps(),
                hooks: exportHooks(job, options.diskGuard)
            });
            return result;
        } catch (error) {
            throw error;
        }
    }

    const routes = [];

    // ---- 预览：档位、内容项和各项估算大小 ----
    routes.push({
        method: 'GET',
        match: p => (p === '/api/transfer/preview' ? [] : null),
        handler: async () => {
            const names = String(requestUrl.searchParams.get('containers') || '').split(',').map(s => s.trim()).filter(Boolean);
            const estimates = {};
            const containers = [];
            const workKeys = new Set();
            const tasks = [];
            const add = (id, promise) => tasks.push(promise.then(bytes => { estimates[id] = estimates[id] === null || bytes === null ? null : (estimates[id] || 0) + bytes; }));
            for (const name of names.slice(0, MAX_CONTAINERS)) {
                if (!ctx.isValidContainerName(name)) continue;
                const info = ctx.containerExists(name) ? runtime.inspect(name) : null;
                const history = deps.loadHistory(name);
                containers.push({ name, remark: history.remark || '', status: info ? info.status : 'history' });
                const hostPath = (history.runtimeSnapshot && history.runtimeSnapshot.hostPath) || (history.applied && history.applied.hostPath) || '';
                if (hostPath) {
                    let real = '';
                    try { real = fs.realpathSync(hostPath); } catch (error) { real = ''; }
                    if (real && !workKeys.has(real)) { workKeys.add(real); add('workdir', duBytes(real)); }
                }
                if (info && info.id && deps.containerState.isValidId(info.id)) {
                    const paths = deps.containerState.paths(homeDir, info.id);
                    add('uploads', duBytes(path.join(paths.box, 'uploads')));
                    add('snapshots', duBytes(path.join(paths.box, 'snap.git')));
                }
            }
            await Promise.all(tasks);
            // 容器内的数据（Agent 记录、系统层）要读 diff 才知道，预览里不算，显示“未知”
            for (const item of plan.ITEMS) if (!(item.id in estimates)) estimates[item.id] = ['agentSessions', 'agentExtras', 'systemLayer'].includes(item.id) ? null : 0;
            ensureExportsDir();
            sendJson(res, 200, {
                tiers: plan.TIERS,
                items: plan.ITEMS,
                estimates,
                containers,
                zstd: zstdAvailable(),
                freeBytes: freeBytes(exportsDir, ctx.statfsSync)
            });
        }
    });

    // ---- 导出 ----
    routes.push({
        method: 'POST',
        match: p => (p === '/api/exports' ? [] : null),
        handler: async () => {
            try {
                const body = await readJsonBody(req);
                const names = validateContainerNames(body.containers);
                const items = plan.normalizeItems(Array.isArray(body.items) ? body.items : undefined, body.tier || 'standard');
                const output = body.output === 'server' ? 'server' : 'download';
                const options = {
                    items,
                    includeSecrets: body.includeSecrets !== false,
                    compression: body.compression === 'small' ? 'small' : 'fast',
                    diskGuard: output === 'server'
                };
                const estimate = Math.max(0, Number(body.estimate) || 0);
                const job = registry.create({ type: 'export', containers: names, meta: { output, options, estimate }, status: output === 'download' ? 'waiting' : 'running' });
                job.update({ estimate });
                if (output === 'download') {
                    job.waitTimer = setTimeout(() => {
                        if (job.status === 'waiting') job.finish('cancelled', { error: '没有开始下载，已取消' });
                    }, DOWNLOAD_WAIT_MS);
                    job.waitTimer.unref();
                    sendJson(res, 200, { jobId: job.id, output, downloadUrl: `/api/exports/${job.id}/download` });
                    return;
                }
                ensureExportsDir();
                const free = freeBytes(exportsDir, ctx.statfsSync);
                if (free !== null && free < estimate * 1.1 + MIN_FREE_BYTES) {
                    job.finish('failed', { error: '服务器剩余磁盘空间不够，请改用“直接下载”或清理空间' });
                    throw httpError(507, '服务器剩余磁盘空间不够，请改用“直接下载”或清理空间');
                }
                const name = archiveFileName();
                const final = path.join(exportsDir, name);
                const part = `${final}.part`;
                job.update({ partFile: part, result: { file: name } });
                const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o600 });
                sendJson(res, 200, { jobId: job.id, output, file: name });
                runExport(job, out, options).then(result => {
                    fs.renameSync(part, final);
                    job.finish('done', { result: { file: name, bytes: fs.statSync(final).size, entries: result.entries, stats: result.stats } });
                }).catch(error => {
                    try { out.destroy(); fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
                    job.finish(error instanceof JobCancelled ? 'cancelled' : 'failed', { error: error.message || '导出失败' });
                });
            } catch (error) {
                fail(error);
            }
        }
    });

    routes.push({
        method: 'GET',
        match: p => p.match(/^\/api\/exports\/([0-9a-f]{16})\/download$/),
        handler: async match => {
            const job = registry.get(match[1]);
            if (!job || job.type !== 'export' || job.status !== 'waiting' || job.meta.output !== 'download') {
                return fail(httpError(404, '这个下载已经用过或已过期，请重新导出'));
            }
            clearTimeout(job.waitTimer);
            // 开始的这一刻才锁容器；有别的任务占着就拒绝
            try {
                for (const name of job.containers) {
                    const busy = registry.busyFor(name);
                    if (busy) throw httpError(409, '这个容器正在导出或导入', { busy: busy.type, jobId: busy.id });
                    if (state.agentRuns && state.agentRuns.get(name)) throw httpError(409, `容器 ${name} 里有 AGENT 正在执行，请等它结束或先停止再导出`);
                }
            } catch (error) {
                job.finish('failed', { error: error.message });
                return fail(error);
            }
            job.update({ status: 'running' });
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${archiveFileName()}"`,
                'Cache-Control': 'no-store'
            });
            res.on('close', () => {
                if (job.status === 'running') job.cancelRequested = true;
            });
            runExport(job, res, job.meta.options).then(result => {
                job.finish('done', { result: { bytes: job.bytes, entries: result.entries, stats: result.stats } });
            }).catch(error => {
                job.finish(error instanceof JobCancelled ? 'cancelled' : 'failed', { error: error.message || '导出失败' });
                if (!res.writableEnded) res.destroy();
            });
        }
    });

    // ---- 任务 ----
    routes.push({
        method: 'GET',
        match: p => (p === '/api/jobs' ? [] : null),
        handler: async () => sendJson(res, 200, { jobs: registry.list() })
    });
    routes.push({
        method: 'GET',
        match: p => p.match(/^\/api\/jobs\/([0-9a-f]{16})$/),
        handler: async match => {
            const job = registry.get(match[1]);
            if (!job) return fail(httpError(404, '找不到这个任务'));
            sendJson(res, 200, { job: job.view() });
        }
    });
    routes.push({
        method: 'POST',
        match: p => p.match(/^\/api\/jobs\/([0-9a-f]{16})\/cancel$/),
        handler: async match => {
            const job = registry.get(match[1]);
            if (!job) return fail(httpError(404, '找不到这个任务'));
            if (job.status === 'waiting') {
                clearTimeout(job.waitTimer);
                job.finish('cancelled', { error: '已取消' });
            } else {
                registry.cancel(job.id);
            }
            sendJson(res, 200, { job: job.view() });
        }
    });

    // ---- 服务器上的导出文件 ----
    routes.push({
        method: 'GET',
        match: p => (p === '/api/exports' ? [] : null),
        handler: async () => {
            ensureExportsDir();
            const files = fs.readdirSync(exportsDir).filter(name => FILE_RE.test(name)).map(name => {
                const stat = fs.statSync(path.join(exportsDir, name));
                return { name, size: stat.size, mtime: stat.mtime.toISOString() };
            }).sort((a, b) => b.mtime.localeCompare(a.mtime));
            sendJson(res, 200, { dir: exportsDir, files, freeBytes: freeBytes(exportsDir, ctx.statfsSync) });
        }
    });
    routes.push({
        method: 'GET',
        match: p => p.match(/^\/api\/exports\/files\/([^/]+)$/),
        handler: async match => {
            const name = decodeURIComponent(match[1]);
            if (!FILE_RE.test(name)) return fail(httpError(400, '文件名不合法'));
            const file = path.join(exportsDir, name);
            let stat;
            try { stat = fs.lstatSync(file); } catch (error) { return fail(httpError(404, '找不到这个文件')); }
            if (!stat.isFile()) return fail(httpError(404, '找不到这个文件'));
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
            const reader = fs.createReadStream(file);
            reader.on('error', () => res.destroy());
            res.on('close', () => reader.destroy());
            reader.pipe(res);
        }
    });
    routes.push({
        method: 'DELETE',
        match: p => p.match(/^\/api\/exports\/files\/([^/]+)$/),
        handler: async match => {
            const name = decodeURIComponent(match[1]);
            if (!FILE_RE.test(name)) return fail(httpError(400, '文件名不合法'));
            const file = path.join(exportsDir, name);
            try {
                if (!fs.lstatSync(file).isFile()) throw new Error('x');
                fs.unlinkSync(file);
            } catch (error) {
                return fail(httpError(404, '找不到这个文件'));
            }
            sendJson(res, 200, { deleted: name });
        }
    });

    // ---- 导入：先看清单 ----
    routes.push({
        method: 'POST',
        match: p => (p === '/api/imports/inspect' ? [] : null),
        handler: async () => {
            try {
                let head;
                const type = String(req.headers['content-type'] || '');
                if (type.includes('application/json')) {
                    const body = await readJsonBody(req);
                    const name = String(body.serverFile || '');
                    if (!FILE_RE.test(name)) throw httpError(400, '文件名不合法');
                    try { head = readHead(path.join(exportsDir, name), HEAD_BYTES); } catch (error) { throw httpError(404, '找不到这个文件'); }
                } else {
                    head = await readRequestHead(req, HEAD_BYTES);
                }
                let manifest;
                try { manifest = await inspectArchiveHead(head); } catch (error) { throw httpError(400, error.message); }
                const quickPath = deps.quickChatPath();
                const taken = new Set([...deps.listContainerNames(), ...deps.listHistoryNames()]);
                const containers = manifest.containers.map(item => {
                    let suggested = item.name;
                    for (let n = 2; taken.has(suggested) && n < 1000; n += 1) suggested = `${item.name}-${n}`;
                    taken.add(suggested);
                    return {
                        idx: item.idx,
                        name: item.name,
                        remark: typeof item.remark === 'string' ? item.remark.slice(0, 200) : '',
                        image: typeof item.image === 'string' ? item.image.slice(0, 200) : '',
                        containerPath: typeof item.containerPath === 'string' ? item.containerPath : '',
                        hostPath: typeof item.hostPath === 'string' ? item.hostPath : '',
                        fidelity: item.fidelity === 'partial' ? 'partial' : 'full',
                        work: item.work === undefined ? null : item.work,
                        nameTaken: taken.has(item.name) && (ctx.containerExists(item.name) || deps.historyExists(item.name)),
                        suggestedName: suggested,
                        suggestedHostPath: item.work === null || item.work === undefined ? '' : path.join(quickPath, suggested),
                        risks: item.risks && typeof item.risks === 'object' ? item.risks : {}
                    };
                });
                sendJson(res, 200, {
                    format: manifest.format,
                    manyoyoVersion: manifest.manyoyoVersion || '',
                    createdAt: manifest.createdAt || '',
                    items: manifest.items,
                    tier: manifest.tier || plan.matchTier(manifest.items),
                    includeSecrets: manifest.includeSecrets === true,
                    containers,
                    localImage: `${ctx.imageName}:${ctx.imageVersion}`
                });
            } catch (error) {
                fail(error);
            }
        }
    });

    function validatePlan(rawPlan) {
        if (!rawPlan || typeof rawPlan !== 'object' || typeof rawPlan.containers !== 'object' || !rawPlan.containers) throw httpError(400, '导入设置不对');
        const out = { containers: {} };
        const usedNames = new Set();
        const taken = new Set([...deps.listContainerNames(), ...deps.listHistoryNames()]);
        const workDest = new Map();
        for (const [key, value] of Object.entries(rawPlan.containers)) {
            if (!/^\d{1,4}$/.test(key) || !value || typeof value !== 'object') throw httpError(400, '导入设置不对');
            const name = String(value.name || '');
            if (!NAME_RE.test(name) || name.length > 120 || !ctx.isValidContainerName(name)) throw httpError(400, `容器名不合法: ${name.slice(0, 60)}`);
            if (taken.has(name) || usedNames.has(name)) throw httpError(409, `容器名已存在: ${name}`);
            usedNames.add(name);
            const imageMode = value.imageMode === 'default' ? 'default' : 'same';
            const hostPath = String(value.hostPath || '');
            const entry = { name, imageMode, confirm: value.confirm && typeof value.confirm === 'object' ? value.confirm : {}, hostPath };
            if (hostPath) {
                if (!path.isAbsolute(hostPath) || hostPath.includes('\0') || path.normalize(hostPath) !== hostPath.replace(/\/+$/, '')) throw httpError(400, `工作目录必须是绝对路径: ${hostPath}`);
                const manyoyoHome = path.join(homeDir, '.manyoyo');
                // ~/.manyoyo 里是配置、历史和容器状态，不能当工作目录；只有默认的工作目录根 ~/.manyoyo/work 例外
                const workRoot = path.join(manyoyoHome, 'work');
                const inWorkRoot = hostPath.startsWith(`${workRoot}${path.sep}`);
                if ((hostPath === manyoyoHome || hostPath.startsWith(`${manyoyoHome}${path.sep}`)) && !inWorkRoot) throw httpError(400, '工作目录不能放在 ~/.manyoyo 里（~/.manyoyo/work 下的子目录可以）');
                // 目录此刻还不存在（导入时才建），这里只挡明显不能挂的位置；建好后创建容器时还会按挂载规则再校验一遍
                const userHome = process.env.HOME || os.homedir() || '/home';
                if (hostPath === '/' || hostPath === '/home' || hostPath === userHome) throw httpError(400, '不允许把根目录或 home 目录当作工作目录');
                // 上一级不存在时导入会一并建出来（默认的 ~/.manyoyo/work 第一次用就不存在）；只要求最近的已有上级是目录
                let probe = path.dirname(hostPath);
                while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
                if (!fs.statSync(probe).isDirectory()) throw httpError(400, `工作目录的上级不是目录: ${probe}`);
            }
            out.containers[Number(key)] = entry;
            workDest.set(hostPath, true);
        }
        if (!Object.keys(out.containers).length) throw httpError(400, '没有选择要导入的容器');
        return out;
    }

    // ---- 导入：开始 ----
    routes.push({
        method: 'POST',
        match: p => (p === '/api/imports' ? [] : null),
        handler: async () => {
            let job = null;
            let source = null;
            try {
                const type = String(req.headers['content-type'] || '');
                let rawPlan;
                if (type.includes('application/json')) {
                    const body = await readJsonBody(req);
                    const name = String(body.serverFile || '');
                    if (!FILE_RE.test(name)) throw httpError(400, '文件名不合法');
                    const file = path.join(exportsDir, name);
                    try {
                        if (!fs.lstatSync(file).isFile()) throw new Error('x');
                    } catch (error) { throw httpError(404, '找不到这个文件'); }
                    source = fs.createReadStream(file);
                    rawPlan = body.plan;
                } else {
                    const planText = requestUrl.searchParams.get('plan') || '';
                    if (planText.length > MAX_PLAN_BYTES) throw httpError(400, '导入设置过大');
                    try { rawPlan = JSON.parse(planText); } catch (error) { throw httpError(400, '导入设置不是合法的 JSON'); }
                    source = req;
                }
                if ([...registry.list()].some(item => item.type === 'import' && item.status === 'running')) throw httpError(409, '已经有一个导入在进行，等它结束再试');
                const importPlan = validatePlan(rawPlan);
                const names = Object.values(importPlan.containers).map(item => item.name);
                job = registry.create({ type: 'import', containers: names, meta: {} });
                const result = await importArchive({
                    source,
                    plan: importPlan,
                    deps: {
                        homeDir,
                        webHistoryDir: state.webHistoryDir,
                        statfs: ctx.statfsSync,
                        runtime,
                        containerState: deps.containerState,
                        createContainer: args => deps.createImportedContainer(args),
                        removeContainer: (name, id) => deps.removeCreatedContainer(name, id),
                        saveHistory: (name, history, info) => deps.saveImportedHistory(name, history, info)
                    },
                    job
                });
                job.finish('done', { result });
                sendJson(res, 200, { jobId: job.id, containers: result.containers, stats: result.stats });
            } catch (error) {
                if (job) job.finish(error instanceof JobCancelled ? 'cancelled' : 'failed', { error: error.message || '导入失败' });
                const status = error instanceof ImportError ? 400 : (error.statusCode || (error && error.name === 'UnsafeEntryError' ? 400 : 500));
                // 上传没读完就报错时，把剩下的丢掉再回复，浏览器才能收到错误
                if (!req.complete && !res.headersSent) req.resume();
                if (source && source !== req && typeof source.destroy === 'function') source.destroy();
                fail(Object.assign(error, { statusCode: status }));
            }
        }
    });

    return routes;
}

// 导入时建容器（server.js 注入 buildCreateRuntime 等能力）：
// 快照来自别人，先按用户确认过滤，再走与“复制容器”相同的校验和创建路径；first 永远不执行。
function createImportContainerFactory({ ctx, state, buildCreateRuntime, ensureWebContainer, resolveContainerId, containerState, loadHistory, patchHistory }) {
    return async function createImportedContainer(args) {
        const history = args.history && typeof args.history === 'object' ? args.history : {};
        const snapshot = history.runtimeSnapshot && typeof history.runtimeSnapshot === 'object' ? history.runtimeSnapshot : {};
        const { createOptions, dropped } = buildImportCreateOptions(snapshot, args.confirm, {
            hostPath: args.hostPath,
            imageMode: args.imageMode,
            trustedImages: [ctx.imageName],
            pathExists: p => { try { return fs.existsSync(p); } catch (error) { return false; } }
        });
        createOptions.containerName = args.newName;
        if (!createOptions.containerPath) throw httpError(400, '归档里没有容器内工作目录，无法导入');
        // 校验到现在名字可能被占了（上传期间别处新建了同名容器）：不能把导入写进别人的容器
        if (ctx.containerExists(args.newName)) throw httpError(409, `容器名已存在: ${args.newName}`);
        const runtime = buildCreateRuntime(ctx, state, { createOptions, allowReservedName: true });
        runtime.first = null;
        try {
            await ensureWebContainer(ctx, state, runtime);
        } catch (error) {
            // 容器可能已经建出来了：登记下来，撤销时才能删掉
            const leftoverId = resolveContainerId(ctx.dockerExecArgs, args.newName);
            if (leftoverId && args.onCreated) args.onCreated(args.newName, leftoverId);
            throw error;
        }
        const id = resolveContainerId(ctx.dockerExecArgs, args.newName);
        if (!id) throw httpError(500, '容器创建后读不到 manyoyo.id');
        if (args.onCreated) args.onCreated(args.newName, id);
        patchHistory(args.newName, { applied: runtime.applied, runtimeSnapshot: runtime.runtimeSnapshot });
        const home = ctx.homeDir || os.homedir();
        const paths = containerState.paths(home, id);
        // 归档里的用户环境变量（含面板里后来改过的）覆盖建容器时从快照带来的那份；非法行由 writeEnv 的校验拒绝
        if (typeof args.stateFiles.env === 'string') {
            try { containerState.writeEnv(home, id, args.stateFiles.env, { parseEnvEntry }); } catch (error) { dropped.push(`环境变量未还原: ${error.message}`); }
        }
        if (args.confirm && args.confirm.autostart === true && typeof args.stateFiles['autostart.sh'] === 'string') {
            try { containerState.writeAutostart(home, id, args.stateFiles['autostart.sh']); } catch (error) { dropped.push(`自启动脚本未还原: ${error.message}`); }
        }
        return { containerName: args.newName, id, paths, dropped };
    };
}

module.exports = { createTransferRoutes, createImportContainerFactory, FILE_RE, exportsDirOf, httpError };
