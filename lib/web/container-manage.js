'use strict';

const os = require('os');
const net = require('net');
const state_ = require('../container-state');
const { resolveContainerId } = require('../container-exec');
const { normalizePolicy } = require('../network-policy');
const { parseEnvEntry } = require('../runtime-normalizers');

// 容器管理接口：环境变量、自启动、网络（含端口暴露）、孤儿状态目录。
// 全部挂在全局认证网关之后；非只读请求由 handleWebApi 统一校验 X-Requested-With。
const LEGACY_MESSAGE = '该容器创建于旧版本，重建后可用';

function isLoopbackBind(bind) {
    return bind === '127.0.0.1' || bind === '::1';
}

// 需要二次确认的风险：切到 open（等于不加规则）、新增非 loopback 的端口暴露
function pendingRisks(before, after) {
    const risks = [];
    if (after.preset === 'open' && before.preset !== 'open') risks.push('open');
    const had = new Set(before.expose.filter(e => !isLoopbackBind(e.bind)).map(e => `${e.bind}:${e.hostPort}`));
    if (after.expose.some(e => !isLoopbackBind(e.bind) && !had.has(`${e.bind}:${e.hostPort}`))) risks.push('publicBind');
    return risks;
}

function parseTail(value, fallback = 16 * 1024) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return fallback;
    return Math.min(n, 64 * 1024);
}

function createContainerManageRoutes({ ctx, state, req, res, deps }) {
    const { sendJson, readJsonBody, decodeSessionName, getNetworkManager, getPortForwarder, ensureWebContainer, execCommandInWebContainer } = deps;
    const homeDir = ctx.homeDir || os.homedir();
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    // 解析容器：名字合法、存在、有 manyoyo.id 且状态目录在。失败时已回复，返回 null。
    function resolveTarget(encodedName, { write = false } = {}) {
        const name = decodeSessionName(encodedName);
        if (!ctx.isValidContainerName(name)) {
            sendJson(res, 400, { error: `containerName 非法: ${name}` });
            return null;
        }
        if (!ctx.containerExists(name)) {
            sendJson(res, 404, { error: `容器不存在: ${name}` });
            return null;
        }
        const id = resolveContainerId(ctx.dockerExecArgs, name);
        if (!id || !state_.stateExists(homeDir, id)) {
            if (write) sendJson(res, 409, { error: LEGACY_MESSAGE, legacy: true });
            else sendJson(res, 200, { legacy: true, message: LEGACY_MESSAGE });
            return null;
        }
        return { name, id };
    }

    function readPolicy(id) {
        return normalizePolicy(state_.readNetworkRaw(homeDir, id) || undefined);
    }

    function writePolicy(id, policy) {
        state_.writeNetworkRaw(homeDir, id, policy);
    }

    function isRunning(name) {
        try {
            return ctx.getContainerStatus(name) === 'running';
        } catch (e) {
            return false;
        }
    }

    function envPayload(id) {
        const env = state_.readEnv(homeDir, id);
        return {
            legacy: false,
            id,
            text: env.text,
            entries: env.entries,
            invalid: env.invalid,
            etag: env.etag,
            mtime: env.mtimeMs ? new Date(env.mtimeMs).toISOString() : null
        };
    }

    async function networkPayload(target, extra = {}) {
        const policy = readPolicy(target.id);
        const manager = getNetworkManager();
        let peers = [];
        try {
            peers = (await manager.listManaged()).filter(item => item.id !== target.id).map(item => ({ id: item.id, name: item.name, running: item.running }));
        } catch (e) {
            peers = [];
        }
        return {
            legacy: false,
            id: target.id,
            running: isRunning(target.name),
            policy,
            status: state_.readNetStatus(homeDir, target.id),
            forwards: getPortForwarder().list(target.id),
            peers,
            ...extra
        };
    }

    // 保存策略后：下发规则（容器在运行时）、同步端口转发、重算有 peers 关系的容器
    async function applyPolicy(target, policy) {
        const out = { applyError: '', forwardFailures: [] };
        const running = isRunning(target.name);
        if (running) {
            const manager = getNetworkManager();
            try {
                await manager.apply(target.name, { expectId: target.id });
                for (const related of await manager.relatedContainers(target.name)) {
                    await manager.apply(related).catch(e => ctx.logger.warn('related container network apply failed', { related, message: e && e.message }));
                }
            } catch (e) {
                out.applyError = e.message;
            }
        }
        out.forwardFailures = await getPortForwarder().sync(target.id, policy.expose);
        return out;
    }

    async function putNetwork(target, body) {
        if (!body.policy || typeof body.policy !== 'object' || Array.isArray(body.policy)) {
            sendJson(res, 400, { error: 'policy 必须是对象' });
            return;
        }
        const before = readPolicy(target.id);
        const next = normalizePolicy({ ...body.policy, autostartOnServe: body.policy && body.policy.autostartOnServe !== undefined ? body.policy.autostartOnServe : before.autostartOnServe });
        for (const entry of next.peers.inbound) {
            if (entry.from === target.id || !state_.stateExists(homeDir, entry.from)) {
                sendJson(res, 400, { error: `peers.inbound 里的容器不存在: ${entry.from}` });
                return;
            }
        }
        const risks = pendingRisks(before, next);
        if (risks.length && body.confirmRisk !== true) {
            sendJson(res, 400, { error: '该改动会放开网络限制，需要确认', needsConfirm: true, risks });
            return;
        }
        writePolicy(target.id, next);
        state_.setNetRequired(homeDir, target.id, next.preset !== 'open');
        const result = await applyPolicy(target, next);
        const payload = await networkPayload(target, { applyError: result.applyError, forwardFailures: result.forwardFailures });
        sendJson(res, result.applyError ? 502 : 200, result.applyError ? { error: result.applyError, ...payload } : payload);
    }

    async function postExpose(target, body) {
        const policy = readPolicy(target.id);
        const entry = { bind: body.bind, hostPort: body.hostPort, port: body.port };
        const next = normalizePolicy({ ...policy, expose: [...policy.expose, entry] });
        const risks = pendingRisks(policy, next);
        if (risks.length && body.confirmRisk !== true) {
            sendJson(res, 400, { error: '绑定非本机地址会让局域网可见，需要确认', needsConfirm: true, risks });
            return;
        }
        const added = next.expose[next.expose.length - 1];
        const failures = await getPortForwarder().sync(target.id, [...policy.expose, added]);
        if (failures.length) {
            sendJson(res, 409, { error: failures[0] });
            return;
        }
        writePolicy(target.id, next);
        sendJson(res, 200, await networkPayload(target));
    }

    async function deleteExpose(target, body) {
        const policy = readPolicy(target.id);
        const bind = String(body.bind || '').trim();
        const hostPort = Number(body.hostPort);
        const rest = policy.expose.filter(e => !(e.bind === bind && e.hostPort === hostPort));
        if (rest.length === policy.expose.length) {
            sendJson(res, 404, { error: '没有这条端口暴露' });
            return;
        }
        writePolicy(target.id, { ...policy, expose: rest });
        await getPortForwarder().sync(target.id, rest);
        sendJson(res, 200, await networkPayload(target));
    }

    async function listOrphans() {
        let live = [];
        try {
            live = (await getNetworkManager().listManaged()).map(item => item.id);
        } catch (e) {
            // 运行时不可用时不给“可删”列表，避免误删
            sendJson(res, 503, { error: '容器运行时不可用，无法判断孤儿状态目录' });
            return;
        }
        const orphans = state_.findOrphans(homeDir, live).map(id => {
            const meta = state_.readMeta(homeDir, id);
            return { id, name: meta.name || '', createdAt: meta.createdAt || '' };
        });
        sendJson(res, 200, { orphans });
    }

    return [
        {
            method: 'GET',
            match: p => (p === '/api/containers/orphans' ? [] : null),
            handler: async () => listOrphans()
        },
        {
            method: 'DELETE',
            match: p => p.match(/^\/api\/containers\/orphans\/([0-9a-f]{16})$/),
            handler: async match => {
                const id = match[1];
                let live;
                try {
                    live = (await getNetworkManager().listManaged()).map(item => item.id);
                } catch (e) {
                    sendJson(res, 503, { error: '容器运行时不可用，无法判断孤儿状态目录' });
                    return;
                }
                if (live.includes(id)) {
                    sendJson(res, 409, { error: '该状态目录仍属于一个现有容器' });
                    return;
                }
                if (!state_.stateExists(homeDir, id)) {
                    sendJson(res, 404, { error: '状态目录不存在' });
                    return;
                }
                getPortForwarder().closeFor(id);
                state_.removeState(homeDir, id);
                sendJson(res, 200, { removed: id });
            }
        },
        {
            method: 'GET',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/env$/),
            handler: async match => {
                const target = resolveTarget(match[1]);
                if (target) sendJson(res, 200, envPayload(target.id));
            }
        },
        {
            method: 'PUT',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/env$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                if (typeof body.text !== 'string') {
                    sendJson(res, 400, { error: 'text 必须是字符串' });
                    return;
                }
                const ifMatch = req.headers['if-match'];
                try {
                    state_.writeEnv(homeDir, target.id, body.text, { ifMatch: ifMatch === undefined ? undefined : String(ifMatch).replace(/"/g, ''), parseEnvEntry });
                } catch (e) {
                    if (e.code === 'CONFLICT') {
                        sendJson(res, 409, { error: e.message, conflict: true, ...envPayload(target.id) });
                        return;
                    }
                    sendJson(res, 400, { error: e.message });
                    return;
                }
                sendJson(res, 200, envPayload(target.id));
            }
        },
        {
            method: 'GET',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/autostart$/),
            handler: async match => {
                const target = resolveTarget(match[1]);
                if (!target) return;
                sendJson(res, 200, {
                    legacy: false,
                    id: target.id,
                    script: state_.readAutostart(homeDir, target.id),
                    autostartOnServe: readPolicy(target.id).autostartOnServe
                });
            }
        },
        {
            method: 'PUT',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/autostart$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                if (body.script !== undefined && typeof body.script !== 'string') {
                    sendJson(res, 400, { error: 'script 必须是字符串' });
                    return;
                }
                try {
                    if (body.script !== undefined) state_.writeAutostart(homeDir, target.id, body.script);
                } catch (e) {
                    sendJson(res, 400, { error: e.message });
                    return;
                }
                if (body.autostartOnServe !== undefined) {
                    const policy = readPolicy(target.id);
                    writePolicy(target.id, { ...policy, autostartOnServe: body.autostartOnServe === true });
                }
                sendJson(res, 200, {
                    legacy: false,
                    id: target.id,
                    script: state_.readAutostart(homeDir, target.id),
                    autostartOnServe: readPolicy(target.id).autostartOnServe
                });
            }
        },
        {
            method: 'POST',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/autostart\/run$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                // 经门闩检查：网络规则没就绪不会运行（下发失败直接报错）
                await ensureWebContainer(ctx, state, target.name);
                const result = await execCommandInWebContainer(
                    ctx,
                    target.name,
                    'nohup setsid /bin/bash /run/manyoyo/autostart.sh >> /run/manyoyo/autostart.log 2>&1 < /dev/null & echo started'
                );
                if (result.exitCode !== 0) {
                    sendJson(res, 500, { error: result.output || '启动失败' });
                    return;
                }
                sendJson(res, 200, { started: true });
            }
        },
        {
            method: 'GET',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/autostart\/log$/),
            handler: async match => {
                const target = resolveTarget(match[1]);
                if (!target) return;
                const log = state_.readAutostartLogTail(homeDir, target.id, parseTail(requestUrl.searchParams.get('tail')));
                sendJson(res, 200, { log });
            }
        },
        {
            method: 'GET',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/network$/),
            handler: async match => {
                const target = resolveTarget(match[1]);
                if (target) sendJson(res, 200, await networkPayload(target));
            }
        },
        {
            method: 'PUT',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/network$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                try {
                    await putNetwork(target, body);
                } catch (e) {
                    if (res.headersSent) throw e;
                    sendJson(res, 400, { error: e.message });
                }
            }
        },
        {
            method: 'POST',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/expose$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                try {
                    await postExpose(target, body);
                } catch (e) {
                    if (res.headersSent) throw e;
                    sendJson(res, 400, { error: e.message });
                }
            }
        },
        {
            method: 'DELETE',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/expose$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                await deleteExpose(target, body);
            }
        }
    ];
}

module.exports = { createContainerManageRoutes, pendingRisks, isLoopbackBind };
