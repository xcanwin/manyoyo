'use strict';

// 发布控制台服务：只监听 127.0.0.1 的固定端口，只在维护者执行 `npm run release` 时启动。
// 安全：启动时生成一次性令牌（只出现在启动时打印/打开的地址里）；所有 /api 请求必须带令牌，
// 且 Host / Origin 必须是本机控制台自己，POST 必须是 JSON；对外动作还要请求里明确 confirmed。
// 网页只能“选择执行哪个阶段 + 填写版本/说明/文件”，不能提交任意命令。

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { collectFacts } = require('./facts');
const { STAGES, MANUAL_CHECKLIST, computeStages, nextStage } = require('./stages');
const { ACTIONS, describeCommands, ReleaseError } = require('./actions');
const { JobRunner } = require('./jobs');
const { createBaseContext, createJobContext } = require('./context');
const { ruleCommitMessage, agentCommitMessage } = require('./commit-message');
const { buildVersionSuggestions } = require('./versions');
const { acquireJobLock } = require('./lock');
const { buildNotesDraft } = require('./notes');
const { checkKind, recordCheck } = require('./checks');

const DEFAULT_PORT = 3900;
const HOST = '127.0.0.1';
const FACTS_TTL_MS = 20000;
const CONSOLE_HTML = path.join(__dirname, 'console.html');

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function readBody(req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) { reject(new ReleaseError('BAD_REQUEST', '请求体过大')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (error) {
                reject(new ReleaseError('BAD_REQUEST', '请求体不是有效的 JSON'));
            }
        });
        req.on('error', reject);
    });
}

function createReleaseServer(options = {}) {
    const repoRoot = options.repoRoot || path.join(__dirname, '..', '..');
    const port = options.port === undefined ? DEFAULT_PORT : options.port;
    const token = options.token || crypto.randomBytes(16).toString('hex');
    const base = createBaseContext({ repoRoot, dryRun: Boolean(options.dryRun), fetchImpl: options.fetchImpl });
    if (options.read) base.read = options.read;
    const htmlFile = options.htmlFile || CONSOLE_HTML;

    let cache = { at: 0, facts: null };
    const collect = async () => {
        cache = { at: Date.now(), facts: await (options.collect ? options.collect(base) : collectFacts(base)) };
        return cache.facts;
    };
    const runner = new JobRunner({
        collect,
        makeCtx: (log, signal) => createJobContext(base, log, signal),
        actions: options.actions || ACTIONS,
        describe: describeCommands,
        getState: () => base.state.load(),
        acquireLock: options.acquireLock === undefined ? () => acquireJobLock(repoRoot, 'web') : options.acquireLock,
        dryRun: base.dryRun
    });

    let listenPort = port;
    const allowedHosts = () => new Set([`${HOST}:${listenPort}`, `localhost:${listenPort}`]);

    function authorize(req, url) {
        if (!allowedHosts().has(String(req.headers.host || ''))) throw new ReleaseError('FORBIDDEN', 'Host 不允许');
        const origin = req.headers.origin;
        if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new ReleaseError('FORBIDDEN', 'Origin 不允许');
        const given = req.headers['x-release-token'] || (url.pathname === '/api/events' ? url.searchParams.get('token') : '');
        const a = Buffer.from(String(given || ''));
        const b = Buffer.from(token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ReleaseError('UNAUTHORIZED', '令牌无效');
        if (req.method === 'POST' && !/^application\/json/.test(String(req.headers['content-type'] || ''))) throw new ReleaseError('BAD_REQUEST', 'POST 必须是 application/json');
    }

    async function statusPayload(refresh) {
        if (refresh) await base.readAsync('git', ['fetch', '--quiet', 'origin', '--tags']);
        const facts = refresh || !cache.facts || Date.now() - cache.at > FACTS_TTL_MS ? await collect() : cache.facts;
        const state = base.state.load();
        const stages = computeStages(facts, state);
        const next = nextStage(stages);
        const checklist = (state.checklists || {})[facts.tag] || {};
        const deviceStage = stages.find(stage => stage.id === 'device');
        return {
            version: facts.pkg.version,
            imageVersion: facts.pkg.imageVersion,
            branch: facts.git.branch,
            latestTag: facts.git.latestTag,
            dryRun: base.dryRun,
            stages: stages.map(stage => ({ ...stage, commands: describeCommands(stage.id, facts, {}) })),
            nextStage: next ? next.id : null,
            dirty: facts.git.dirty,
            ruleMessage: ruleCommitMessage(facts.git.dirty),
            suggestions: buildVersionSuggestions((facts.git.latestTag || `v${facts.pkg.version}`).replace(/^v/, '')),
            notesDraft: buildNotesDraft(facts),
            checklist: MANUAL_CHECKLIST.map(item => ({ ...item, done: Boolean(checklist[item.id]) })),
            deviceChecklist: (deviceStage && deviceStage.items) || [],
            job: runner.snapshot(),
            gh: facts.gh.ok
        };
    }

    async function handleApi(req, res, url) {
        const { pathname } = url;
        if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, 200, await statusPayload(url.searchParams.get('refresh') === '1'));
        if (req.method === 'GET' && pathname === '/api/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
            runner.events.forEach(send);
            runner.on('event', send);
            const ping = setInterval(() => res.write(': ping\n\n'), 20000);
            req.on('close', () => { clearInterval(ping); runner.off('event', send); });
            return undefined;
        }
        if (req.method === 'POST' && pathname === '/api/run') {
            const body = await readBody(req);
            const snapshot = runner.start({ stages: body.stages, mode: body.mode, params: body.params || {}, confirmed: body.confirmed === true });
            return sendJson(res, 200, { job: snapshot });
        }
        if (req.method === 'POST' && pathname === '/api/confirm') {
            const body = await readBody(req);
            runner.approve(body.approve === true);
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/api/cancel') return sendJson(res, 200, { cancelled: runner.cancel() });
        if (req.method === 'POST' && pathname === '/api/commit-message') {
            const body = await readBody(req);
            if (body.mode === 'agent') return sendJson(res, 200, await (options.agentCommitMessage || agentCommitMessage)({ repoRoot }));
            const message = ruleCommitMessage(body.files || []);
            return sendJson(res, 200, { message, reason: message ? '' : '没有选择文件' });
        }
        if (req.method === 'POST' && pathname === '/api/checklist') {
            const body = await readBody(req);
            if (!checkKind(body.id)) throw new ReleaseError('BAD_REQUEST', '未知的检查项');
            const tag = (cache.facts || await collect()).tag;
            recordCheck(base.state, tag, body.id, body.done === true, '网页勾选');
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && pathname === '/api/quit') {
            sendJson(res, 200, { ok: true });
            setTimeout(() => server.close(), 50);
            if (options.onQuit) setTimeout(options.onQuit, 100);
            return undefined;
        }
        throw new ReleaseError('NOT_FOUND', '没有这个接口');
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || HOST}`);
        try {
            if (url.pathname === '/api/ping') return sendJson(res, 200, { app: 'manyoyo-release-console' });
            if (url.pathname.startsWith('/api/')) {
                authorize(req, url);
                return await handleApi(req, res, url);
            }
            if (req.method === 'GET' && url.pathname === '/') {
                if (!allowedHosts().has(String(req.headers.host || ''))) throw new ReleaseError('FORBIDDEN', 'Host 不允许');
                if (url.searchParams.get('token') !== token) throw new ReleaseError('UNAUTHORIZED', '请使用启动时打印的完整地址（带 token）打开');
                if (!fs.existsSync(htmlFile)) {
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('页面尚未构建：先执行 npm run build:release');
                }
                const inject = `<script>window.__RELEASE__=${JSON.stringify({ token })}</script>`;
                const html = fs.readFileSync(htmlFile, 'utf-8').replace('</title>', () => `</title>${inject}`);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
                return res.end(html);
            }
            throw new ReleaseError('NOT_FOUND', '页面不存在');
        } catch (error) {
            const status = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BUSY: 409, BLOCKED: 409 }[error.code] || (error instanceof ReleaseError ? 400 : 500);
            if (!res.headersSent) return sendJson(res, status, { error: error.message, code: error.code || 'INTERNAL' });
            return res.end();
        }
    });

    return {
        server,
        token,
        runner,
        base,
        STAGES,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, HOST, () => {
                listenPort = server.address().port;
                resolve({ port: listenPort, url: `http://${HOST}:${listenPort}/?token=${token}` });
            });
        }),
        close: () => new Promise(resolve => server.close(resolve))
    };
}

module.exports = { createReleaseServer, buildNotesDraft, DEFAULT_PORT, HOST };
