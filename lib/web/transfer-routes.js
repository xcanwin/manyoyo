'use strict';

// 容器导出 / 导入的 HTTP 接口。全部在全局认证网关之后，非 GET 请求已由 handleWebApi 校验 X-Requested-With。
// 核心逻辑在 lib/archive/，这里只做：参数校验、任务登记、把请求 / 响应接到流上、把 server.js 里的建容器能力包成 deps。

const fs = require('fs');
const os = require('os');
const path = require('path');

const plan = require('../archive/plan');
const { prepareExport, writeExport, archiveFileName, zstdAvailable } = require('../archive/export');
const { importArchive, inspectArchiveHead, ImportError, NAME_RE } = require('../archive/import');
const { buildImportCreateOptions } = require('../archive/risks');
const { createCliRuntime } = require('../archive/runtime');
const { duBytes } = require('../archive/size');
const { JobCancelled } = require('./container-jobs');
const { parseEnvEntry } = require('../runtime-normalizers');
const { normalizePolicy } = require('../network-policy');

const FILE_RE = /^manyoyo-export-\d{8}-\d{6}\.tar\.(zst|gz)$/;
const HEAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_WAIT_MS = 2 * 60 * 1000; // 准备好后等浏览器来取 / 建好任务后等上传，超过就自动取消
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_CONTAINERS = 50;
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,199}$/;

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

// 客户端断开（浏览器取消、网络断了）：不是导出 / 导入自己的错，记成“已取消”
function isClientGone(error) {
    return Boolean(error) && (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || /^Premature close$/i.test(String(error.message || '')) || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED');
}

function isCancel(error, job) {
    return error instanceof JobCancelled || Boolean(error && (error.name === 'RuntimeAbortError' || error.name === 'ExportCancelled')) || Boolean(job && job.cancelRequested);
}

// 技术性的错误换成一句人话；原始信息只留在日志里
function friendlyError(error) {
    const message = String((error && error.message) || '操作失败');
    if (/unexpected end of file|tar 流被截断|Premature close|EBADF|文件不完整/i.test(message)) return '文件不完整，可能下载或上传被中断，请重新导出 / 重新上传';
    if (/^Command failed: .*(run|create)\b/.test(message) || /^(docker|podman) (run|create)/.test(message)) return '创建容器失败，可能是端口被占用或镜像有问题（详情见服务日志）';
    return message;
}

function createTransferRoutes({ ctx, state, req, res, deps }) {
    const { sendJson, readJsonBody } = deps;
    const homeDir = ctx.homeDir || os.homedir();
    const exportsDir = exportsDirOf(homeDir);
    const registry = state.jobs;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const runtime = ctx.transferRuntime || createCliRuntime({ command: ctx.dockerCmd || 'docker', env: ctx.dockerEnv });
    const logger = ctx.logger || { warn() {}, error() {}, info() {} };
    const WAIT_MS = ctx.transferWaitMs || DEFAULT_WAIT_MS;

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
            duBytes: ctx.duBytes,
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
            signal: job.signal,
            onStage: info => job.update({ stage: info.stage, container: info.container }),
            onPause: (name, info) => job.addPaused(name, info.id),
            onUnpause: name => job.removePaused(name),
            onWarning: (name, message) => { job.warnings.push(message); }
        };
    }

    // 任务因错误结束：取消 / 客户端断开记成 cancelled，其余 failed；原始错误进日志，界面只给一句话
    function finishWithError(job, error, { clientGone = false } = {}) {
        if (isCancel(error, job)) return job.finish('cancelled', { error: '已取消' });
        if (clientGone || isClientGone(error)) return job.finish('cancelled', { error: '连接中断，已取消' });
        logger.warn(`${job.type === 'export' ? '导出' : '导入'}任务失败: ${error && error.stack ? error.stack : error}`);
        return job.finish('failed', { error: error instanceof ImportError || error.statusCode ? error.message : friendlyError(error) });
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
            const duFn = ctx.duBytes || duBytes;
            const add = (id, promise) => tasks.push(promise.then(bytes => { estimates[id] = estimates[id] === null || bytes === null ? null : (estimates[id] || 0) + bytes; }));
            for (const name of names.slice(0, MAX_CONTAINERS)) {
                if (!ctx.isValidContainerName(name)) continue;
                // 正在导出 / 导入的容器不去问运行时（docker 在 cp 期间会让同一容器的 inspect 一直等）
                const busy = registry.busyFor(name);
                let info = null;
                if (ctx.containerExists(name) && !busy) {
                    try { info = await runtime.inspect(name, { timeout: 5000 }); } catch (error) { info = null; }
                }
                const history = deps.loadHistory(name);
                containers.push({ name, remark: history.remark || '', status: busy ? 'busy' : (info ? info.status : 'history') });
                const hostPath = (history.runtimeSnapshot && history.runtimeSnapshot.hostPath) || (history.applied && history.applied.hostPath) || '';
                if (hostPath) {
                    let real = '';
                    try { real = fs.realpathSync(hostPath); } catch (error) { real = ''; }
                    if (real && !workKeys.has(real)) { workKeys.add(real); add('workdir', duFn(real)); }
                }
                if (info && info.id && deps.containerState.isValidId(info.id)) {
                    const paths = deps.containerState.paths(homeDir, info.id);
                    add('uploads', duFn(path.join(paths.box, 'uploads')));
                    add('snapshots', duFn(path.join(paths.box, 'snap.git')));
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

    // ---- 导出：第一段（后台准备）----
    async function prepareJob(job) {
        const options = job.meta.options;
        try {
            const prepared = await prepareExport({
                containers: job.containers.map(name => ({ name })),
                items: options.items,
                includeSecrets: options.includeSecrets,
                deps: exportDeps(),
                hooks: exportHooks(job, false),
                signal: job.signal
            });
            job.check();
            job.prepared = prepared;
            job.update({ estimate: prepared.estimate.bytes, estimateComplete: prepared.estimate.complete, stage: '', container: '' });
            if (job.meta.output === 'download') {
                job.waitTimer = setTimeout(() => {
                    if (job.status === 'ready') {
                        job.prepared = null;
                        job.finish('cancelled', { error: '没有开始下载，已取消' });
                    }
                }, WAIT_MS);
                job.waitTimer.unref();
                job.update({ status: 'ready', downloadUrl: `/api/exports/${job.id}/download` });
                return;
            }
            // 保存到服务器：准备好就直接写文件
            ensureExportsDir();
            const free = freeBytes(exportsDir, ctx.statfsSync);
            if (free !== null && free < prepared.estimate.bytes * 1.1 + MIN_FREE_BYTES) {
                throw httpError(507, '服务器剩余磁盘空间不够，请改用“直接下载”或清理空间');
            }
            const name = archiveFileName();
            const final = path.join(exportsDir, name);
            const part = `${final}.part`;
            job.update({ status: 'running', partFile: part, result: { file: name } });
            const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o600 });
            try {
                const result = await writeExport(prepared, { out, compression: options.compression, deps: exportDeps(), hooks: exportHooks(job, true) });
                fs.renameSync(part, final);
                job.finish('done', { result: { file: name, bytes: fs.statSync(final).size, entries: result.entries, stats: result.stats, warnings: result.warnings } });
            } catch (error) {
                try { out.destroy(); fs.rmSync(part, { force: true }); } catch (e) { /* ignore */ }
                throw error;
            }
        } catch (error) {
            job.prepared = null;
            finishWithError(job, error);
        }
    }

    routes.push({
        method: 'POST',
        match: p => (p === '/api/exports' ? [] : null),
        handler: async () => {
            try {
                const body = await readJsonBody(req);
                const names = validateContainerNames(body.containers);
                const items = plan.normalizeItems(Array.isArray(body.items) ? body.items : undefined, body.tier || 'standard');
                const output = body.output === 'server' ? 'server' : 'download';
                if (output === 'server') {
                    ensureExportsDir();
                    const free = freeBytes(exportsDir, ctx.statfsSync);
                    if (free !== null && free < MIN_FREE_BYTES) throw httpError(507, '服务器剩余磁盘空间不够，请改用“直接下载”或清理空间');
                }
                const options = {
                    items,
                    includeSecrets: body.includeSecrets !== false,
                    compression: body.compression === 'small' ? 'small' : 'fast'
                };
                // 建任务的这一刻起容器就被锁住（准备中 → 等下载 → 下载中都算）
                const job = registry.create({ type: 'export', containers: names, meta: { output, options }, status: 'preparing' });
                sendJson(res, 202, { jobId: job.id, output });
                prepareJob(job);
            } catch (error) {
                fail(error);
            }
        }
    });

    // ---- 导出：第二段（浏览器来取，开始流式写出）----
    routes.push({
        method: 'GET',
        match: p => p.match(/^\/api\/exports\/([0-9a-f]{16})\/download$/),
        handler: async match => {
            const job = registry.get(match[1]);
            if (!job || job.type !== 'export' || job.status !== 'ready' || job.meta.output !== 'download' || !job.prepared) {
                return fail(httpError(404, '这个下载已经用过或已过期，请重新导出'));
            }
            clearTimeout(job.waitTimer);
            const prepared = job.prepared;
            job.prepared = null;
            job.update({ status: 'running' });
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${archiveFileName()}"`,
                'Cache-Control': 'no-store',
                // 不让 nginx 把整个下载先缓存到服务器磁盘
                'X-Accel-Buffering': 'no'
            });
            res.flushHeaders();
            let clientGone = false;
            res.on('close', () => {
                if (!res.writableFinished) {
                    clientGone = true;
                    if (job.status === 'running') registry.cancel(job.id);
                }
            });
            writeExport(prepared, { out: res, compression: job.meta.options.compression, deps: exportDeps(), hooks: exportHooks(job, false) }).then(result => {
                job.finish('done', { result: { bytes: job.bytes, entries: result.entries, stats: result.stats, warnings: result.warnings } });
            }).catch(error => {
                finishWithError(job, error, { clientGone });
                // 中途出错必须让连接以错误结束，不能正常结束成一个不完整的 200
                if (!res.writableEnded) res.destroy(error);
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
            registry.cancel(job.id);
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
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
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
                const taken = new Set([...deps.listContainerNames(), ...deps.listHistoryNames(), ...registry.reservedNames()]);
                const trusted = new Set(['ghcr.io/xcanwin/manyoyo', 'localhost/xcanwin/manyoyo', ctx.imageName]);
                const imageChecks = new Map();
                const imageStatus = async image => {
                    if (!image) return 'unknown';
                    if (!imageChecks.has(image)) {
                        imageChecks.set(image, (async () => {
                            const ref = image.slice(0, 200);
                            const repo = ref.includes(':') ? ref.slice(0, ref.lastIndexOf(':')) : ref;
                            if (!IMAGE_REF_RE.test(ref) || !trusted.has(repo)) return 'untrusted';
                            if (!deps.imageExists) return 'unknown';
                            return (await deps.imageExists(ref)) ? 'present' : 'missing';
                        })());
                    }
                    return imageChecks.get(image);
                };
                const containers = [];
                for (const item of manifest.containers) {
                    let suggested = item.name;
                    for (let n = 2; taken.has(suggested) && n < 1000; n += 1) suggested = `${item.name}-${n}`;
                    taken.add(suggested);
                    containers.push({
                        idx: item.idx,
                        name: item.name,
                        remark: typeof item.remark === 'string' ? item.remark.slice(0, 200) : '',
                        image: typeof item.image === 'string' ? item.image.slice(0, 200) : '',
                        imageStatus: await imageStatus(typeof item.image === 'string' ? item.image : ''),
                        containerPath: typeof item.containerPath === 'string' ? item.containerPath : '',
                        hostPath: typeof item.hostPath === 'string' ? item.hostPath : '',
                        fidelity: item.fidelity === 'partial' ? 'partial' : 'full',
                        work: item.work === undefined ? null : item.work,
                        nameTaken: (ctx.containerExists(item.name) || deps.historyExists(item.name) || registry.reservedNames().has(item.name)),
                        suggestedName: suggested,
                        suggestedHostPath: item.work === null || item.work === undefined ? '' : path.join(quickPath, suggested),
                        risks: item.risks && typeof item.risks === 'object' ? item.risks : {}
                    });
                }
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
        const taken = new Set([...deps.listContainerNames(), ...deps.listHistoryNames(), ...registry.reservedNames()]);
        const checkedDest = new Set();
        for (const [key, value] of Object.entries(rawPlan.containers)) {
            if (!/^\d{1,4}$/.test(key) || !value || typeof value !== 'object') throw httpError(400, '导入设置不对');
            const name = String(value.name || '');
            if (!NAME_RE.test(name) || name.length > 120 || !ctx.isValidContainerName(name)) throw httpError(400, `容器名不合法（只能用字母、数字、下划线、点和短横线，以字母或数字开头，最长 120 个字符）: ${name.slice(0, 40)}${name.length > 40 ? '…' : ''}`);
            if (taken.has(name) || usedNames.has(name)) throw httpError(409, `容器名已存在: ${name}`);
            usedNames.add(name);
            const imageMode = value.imageMode === 'default' ? 'default' : 'same';
            // 结尾的斜杠不影响含义（/ 本身除外，下面会按“不允许根目录”拒绝）
            const rawHostPath = String(value.hostPath || '');
            const hostPath = rawHostPath.length > 1 ? (rawHostPath.replace(/\/+$/, '') || '/') : rawHostPath;
            const remark = typeof value.remark === 'string' ? value.remark.trim().slice(0, 200) : undefined;
            const entry = { name, remark, imageMode, confirm: value.confirm && typeof value.confirm === 'object' ? value.confirm : {}, hostPath };
            if (hostPath) {
                if (!path.isAbsolute(hostPath) || hostPath.includes('\0') || path.normalize(hostPath) !== hostPath) throw httpError(400, `工作目录必须是绝对路径，且不能含 . 或 ..: ${hostPath}`);
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
                // 已经存在且有内容的目录一开始就拒绝（不用等整份上传完才发现）
                if (!checkedDest.has(hostPath)) {
                    checkedDest.add(hostPath);
                    let stat = null;
                    try { stat = fs.lstatSync(hostPath); } catch (error) { stat = null; }
                    if (stat && !stat.isDirectory()) throw httpError(400, `工作目录已存在，但不是目录: ${hostPath}`);
                    if (stat && fs.readdirSync(hostPath).length > 0) throw httpError(409, `工作目录已存在且不为空: ${hostPath}`);
                }
            }
            out.containers[Number(key)] = entry;
        }
        if (!Object.keys(out.containers).length) throw httpError(400, '没有选择要导入的容器');
        return out;
    }

    function importOptionsFor(job, importPlan, source, extra = {}) {
        return {
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
                saveHistory: (name, history, info) => deps.saveImportedHistory(name, history, info),
                applyDeleted: deps.applyDeletedLayer
            },
            job,
            ...extra
        };
    }

    function assertNoImportActive() {
        if (registry.active().some(item => item.type === 'import')) throw httpError(409, '已经有一个导入在进行，等它结束再试');
    }

    // ---- 导入：服务器上的文件（立即返回任务号，导入在后台跑）----
    routes.push({
        method: 'POST',
        match: p => (p === '/api/imports' ? [] : null),
        handler: async () => {
            let source = null;
            try {
                const body = await readJsonBody(req);
                const name = String(body.serverFile || '');
                if (!FILE_RE.test(name)) throw httpError(400, '文件名不合法');
                const file = path.join(exportsDir, name);
                try {
                    if (!fs.lstatSync(file).isFile()) throw new Error('x');
                } catch (error) { throw httpError(404, '找不到这个文件'); }
                assertNoImportActive();
                const importPlan = validatePlan(body.plan);
                const names = Object.values(importPlan.containers).map(item => item.name);
                const job = registry.create({ type: 'import', containers: names, meta: {} });
                source = fs.createReadStream(file);
                sendJson(res, 202, { jobId: job.id });
                importArchive(importOptionsFor(job, importPlan, source)).then(result => {
                    job.finish('done', { result });
                }).catch(error => {
                    finishWithError(job, error);
                });
            } catch (error) {
                if (source) source.destroy();
                fail(error);
            }
        }
    });

    // ---- 导入：上传（先登记设置，再上传归档本身；设置不放在 URL 里）----
    routes.push({
        method: 'POST',
        match: p => (p === '/api/imports/uploads' ? [] : null),
        handler: async () => {
            try {
                const body = await readJsonBody(req);
                assertNoImportActive();
                const importPlan = validatePlan(body.plan);
                const names = Object.values(importPlan.containers).map(item => item.name);
                // 建任务就预留新容器名；2 分钟不上传自动取消
                const job = registry.create({ type: 'import', containers: names, meta: { plan: importPlan }, status: 'waiting' });
                job.waitTimer = setTimeout(() => {
                    if (job.status === 'waiting') job.finish('cancelled', { error: '没有开始上传，已取消' });
                }, WAIT_MS);
                job.waitTimer.unref();
                job.update({ uploadUrl: `/api/imports/${job.id}/upload` });
                sendJson(res, 200, { jobId: job.id, uploadUrl: job.uploadUrl });
            } catch (error) {
                fail(error);
            }
        }
    });

    routes.push({
        method: 'POST',
        match: p => p.match(/^\/api\/imports\/([0-9a-f]{16})\/upload$/),
        handler: async match => {
            const job = registry.get(match[1]);
            if (!job || job.type !== 'import' || job.status !== 'waiting' || !job.meta.plan) {
                req.resume();
                return fail(httpError(404, '这个上传已经用过或已过期，请重新开始导入'));
            }
            clearTimeout(job.waitTimer);
            job.update({ status: 'running' });
            let responded = false;
            let clientGone = false;
            req.on('aborted', () => { clientGone = true; });
            const respondOk = () => {
                if (responded) return;
                responded = true;
                sendJson(res, 202, { jobId: job.id });
            };
            importArchive(importOptionsFor(job, job.meta.plan, req, { onBodyComplete: respondOk })).then(result => {
                job.finish('done', { result });
                respondOk();
            }).catch(error => {
                finishWithError(job, error, { clientGone });
                if (!responded) {
                    responded = true;
                    const status = error instanceof ImportError ? 400 : (error.statusCode || (error && error.name === 'UnsafeEntryError' ? 400 : 500));
                    // 上传没读完就报错时，把剩下的丢掉再回复，浏览器才能收到错误
                    if (!req.complete && !res.headersSent) req.resume();
                    fail(Object.assign(new Error(job.error || friendlyError(error)), { statusCode: status }));
                }
            });
        }
    });

    return routes;
}

// 导入时建容器（server.js 注入 buildCreateRuntime 等能力）：
// 快照来自别人，先按用户确认过滤，再走与“复制容器”相同的校验和创建路径；first 永远不执行。
function createImportContainerFactory({ ctx, state, buildCreateRuntime, ensureWebContainer, resolveContainerId, containerState, loadHistory, patchHistory }) {
    return async function createImportedContainer(args) {
        const history = args.history && typeof args.history === 'object' ? args.history : {};
        const snapshot = { ...(history.runtimeSnapshot && typeof history.runtimeSnapshot === 'object' ? history.runtimeSnapshot : {}) };
        // 面板里后来改过的设置在状态目录里，以它为准；仍走同一套“逐项确认”的过滤
        const stateNotes = [];
        const readStateJson = file => {
            if (typeof args.stateFiles[file] !== 'string') return null;
            try { return JSON.parse(args.stateFiles[file]); } catch (error) { return null; }
        };
        const statePolicy = readStateJson('network.json');
        if (statePolicy && typeof statePolicy === 'object' && !Array.isArray(statePolicy)) {
            try {
                normalizePolicy(statePolicy);
                snapshot.network = statePolicy;
            } catch (error) {
                stateNotes.push('面板里的网络规则读不懂，改用建容器时的规则');
            }
        }
        const stateEnvFiles = readStateJson('env-files.json');
        if (stateEnvFiles && Array.isArray(stateEnvFiles.files)) snapshot.envFile = stateEnvFiles.files.filter(item => typeof item === 'string');
        const statePrompt = readStateJson('system-prompt.json');
        if (statePrompt && typeof statePrompt === 'object') snapshot.systemPrompt = { enabled: statePrompt.enabled !== false, text: typeof statePrompt.text === 'string' ? statePrompt.text : '' };
        const { createOptions, dropped } = buildImportCreateOptions(snapshot, args.confirm, {
            hostPath: args.hostPath,
            imageMode: args.imageMode,
            trustedImages: [ctx.imageName],
            pathExists: p => { try { return fs.existsSync(p); } catch (error) { return false; } }
        });
        dropped.push(...stateNotes);
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
            try { containerState.writeAutostart(home, id, args.stateFiles['autostart.sh']); } catch (error) { dropped.push(`自启动脚本没能还原: ${error.message}`); }
        } else if (typeof args.stateFiles['autostart.sh'] === 'string' && args.stateFiles['autostart.sh'].trim() && !dropped.some(item => item.startsWith('自启动脚本'))) {
            // 面板里后来加的自启动脚本只在状态目录里，快照里没有，建容器时的过滤不会提它
            dropped.push('自启动脚本没勾选，没有带上');
        }
        return { containerName: args.newName, id, paths, dropped };
    };
}

module.exports = { createTransferRoutes, createImportContainerFactory, FILE_RE, exportsDirOf, httpError };
