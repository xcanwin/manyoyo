'use strict';

const os = require('os');
const net = require('net');
const state_ = require('../container-state');
const { resolveContainerId } = require('../container-exec');
const { normalizePolicy, resolveContainerRefs, isUnrestricted, domainRuleAllows, targetKind } = require('../network-policy');
const { parseEnvEntry } = require('../runtime-normalizers');
const { envUrlDomains } = require('../network-endpoints');
const { egressPaths } = require('../egress-sidecar');
const deniedLib = require('../egress-denied');
const { isBrowserBackground } = require('../browser-background');

// 容器管理接口：环境变量、自启动、网络（含端口暴露）、孤儿状态目录。
// 全部挂在全局认证网关之后；非只读请求由 handleWebApi 统一校验 X-Requested-With。
const LEGACY_MESSAGE = '该容器创建于旧版本，重建后可用';

function isLoopbackBind(bind) {
    return bind === '127.0.0.1' || bind === '::1';
}

// `wide`：新增的“允许”规则范围极宽，效果接近不设限：任何地址 / 内网 / 元数据、其他容器（入站）、宿主机全部端口、
// /8 以上的网段（含 0.0.0.0/0）、公共后缀通配（*.co.uk 之类）
const PUBLIC_SUFFIX_WILDCARD_RE = /^\*\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
const WIDE_OUTBOUND_VARS = ['@any', '@private', '@metadata'];
const WIDE_INBOUND_VARS = ['@any', '@containers'];

function isWideCidr(cidr) {
    const m = /\/(\d+)$/.exec(cidr);
    const prefix = m ? Number(m[1]) : 32;
    return cidr.includes(':') ? prefix <= 16 : prefix <= 8;
}

function isWideRule(rule, direction) {
    const target = direction === 'inbound' ? rule.source : rule.target;
    if (rule.action !== 'allow' || !rule.enabled) return false;
    const kind = targetKind(target);
    if (kind === 'var') return (direction === 'inbound' ? WIDE_INBOUND_VARS : WIDE_OUTBOUND_VARS).includes(target) || (direction !== 'inbound' && target === '@host' && !rule.ports);
    if (kind === 'cidr') return isWideCidr(target);
    return PUBLIC_SUFFIX_WILDCARD_RE.test(target);
}

function wideKeys(policy) {
    const key = (rule, direction) => `${direction}:${rule.action}|${direction === 'inbound' ? rule.source : rule.target}|${rule.ports}|${rule.proto}`;
    return [
        ...policy.outbound.filter(rule => isWideRule(rule, 'outbound')).map(rule => key(rule, 'outbound')),
        ...policy.inbound.filter(rule => isWideRule(rule, 'inbound')).map(rule => key(rule, 'inbound'))
    ];
}

// 需要二次确认的风险：切到自定义、新增非 loopback 的端口暴露、新增范围极宽的允许规则（自定义里本来就不设限，不再逐条问）
function pendingRisks(before, after) {
    const risks = [];
    if (after.preset === 'custom' && before.preset !== 'custom') risks.push('custom');
    const hadWide = new Set(wideKeys(before));
    if (after.preset !== 'custom' && wideKeys(after).some(key => !hadWide.has(key))) risks.push('wide');
    const had = new Set(before.expose.filter(e => !isLoopbackBind(e.bind)).map(e => `${e.bind}:${e.hostPort}`));
    if (after.expose.some(e => !isLoopbackBind(e.bind) && !had.has(`${e.bind}:${e.hostPort}`))) risks.push('publicBind');
    return risks;
}

function peerIp(info) {
    const networks = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {};
    const pick = networks.manyoyo || Object.values(networks).find(n => n && n.IPAddress);
    return (pick && pick.IPAddress) || '';
}

function parseTail(value, fallback = 16 * 1024) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return fallback;
    return Math.min(n, 64 * 1024);
}

function createContainerManageRoutes({ ctx, state, req, res, deps }) {
    const { sendJson, readJsonBody, decodeSessionName, getNetworkManager, getPortForwarder, ensureWebContainer, execCommandInWebContainer, rememberContainerName } = deps;
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
        rememberContainerName(id, name);
        return { name, id };
    }

    // 名称 → 受管容器 id（只认运行时里真实存在的）
    async function containerIdLookup() {
        try {
            const byName = new Map((await getNetworkManager().listManaged()).map(item => [item.name, item.id]));
            return name => byName.get(name) || '';
        } catch (e) {
            return () => '';
        }
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

    // 环境变量文件的状态（不回传值，只给路径、能不能读、有几个变量、哪些行被跳过）
    function envFilesPayload(id) {
        return state_.readEnvFiles(homeDir, id).map(file => ({
            path: file.path,
            exists: file.exists,
            error: file.error,
            count: file.entries.length,
            invalid: file.invalid
        }));
    }

    function envPayload(id) {
        const env = state_.readEnv(homeDir, id);
        return {
            legacy: false,
            id,
            text: env.text,
            entries: env.entries,
            invalid: env.invalid,
            files: envFilesPayload(id),
            etag: env.etag,
            mtime: env.mtimeMs ? new Date(env.mtimeMs).toISOString() : null,
            warning: env.unsafe ? `容器内的 /run/manyoyo/env ${env.unsafe}，已忽略；保存会用新文件替换它` : ''
        };
    }

    // 最近被过滤代理拦截的域名（已在白名单里的不再列出）；background 标记浏览器自己的后台请求
    function deniedPayload(id, policy) {
        try {
            return deniedLib.read(egressPaths(homeDir).denied, id)
                .filter(record => !domainRuleAllows(policy, record.host))
                .map(record => ({ ...record, background: isBrowserBackground(record.host) }));
        } catch (e) {
            return [];
        }
    }

    async function networkPayload(target, extra = {}) {
        const policy = readPolicy(target.id);
        const manager = getNetworkManager();
        let peers = [];
        try {
            peers = (await manager.listManaged()).filter(item => item.id !== target.id).map(item => ({ id: item.id, name: item.name, running: item.running, ip: (item.running && peerIp(item.info)) || '' }));
        } catch (e) {
            peers = [];
        }
        let derived = [];
        try {
            derived = typeof manager.derivedOf === 'function' ? await manager.derivedOf(target.name) : [];
        } catch (e) {
            derived = [];
        }
        // 建议放行的域名：来自当前环境变量（含容器里改过的）里的 URL。只是建议，要用户自己点才会加进策略
        // （容器可写的 env 不能直接决定防火墙）
        const envLines = [
            ...state_.readEnv(homeDir, target.id).entries.map(entry => `${entry.key}=${entry.value}`),
            ...state_.envFileEntries(homeDir, target.id).map(entry => `${entry.key}=${entry.value}`)
        ];
        const suggestedDomains = envUrlDomains(envLines).filter(domain => !domainRuleAllows(policy, domain));
        return {
            legacy: false,
            id: target.id,
            running: isRunning(target.name),
            suggestedDomains,
            denied: deniedPayload(target.id, policy),
            policy,
            status: state_.readNetStatus(homeDir, target.id),
            forwards: getPortForwarder().list(target.id),
            peers,
            derived,
            unrestricted: isUnrestricted(policy),
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
        const normalized = normalizePolicy({ ...body.policy, autostartOnServe: body.policy && body.policy.autostartOnServe !== undefined ? body.policy.autostartOnServe : before.autostartOnServe });
        let next;
        try {
            next = resolveContainerRefs(normalized, await containerIdLookup());
        } catch (e) {
            sendJson(res, 400, { error: e.message });
            return;
        }
        const risks = pendingRisks(before, next);
        if (risks.length && body.confirmRisk !== true) {
            sendJson(res, 400, { error: '该改动会放开网络限制，需要确认', needsConfirm: true, risks });
            return;
        }
        writePolicy(target.id, next);
        state_.setNetRequired(homeDir, target.id, !isUnrestricted(next));
        const result = await applyPolicy(target, next);
        const payload = await networkPayload(target, { applyError: result.applyError, forwardFailures: result.forwardFailures });
        // 策略已保存；规则下发失败（502）或端口暴露没起来（409，如端口被占）都要明确报错
        if (result.applyError) sendJson(res, 502, { error: result.applyError, ...payload });
        else if (result.forwardFailures.length) sendJson(res, 409, { error: result.forwardFailures[0], ...payload });
        else sendJson(res, 200, payload);
    }

    // 一键放行被拦截的域名：在出站规则最前面插入“允许 <域名>”并立即下发（任何模式都可以）
    async function postAllow(target, body) {
        const domain = String(body.domain || '').trim().toLowerCase();
        const policy = readPolicy(target.id);
        if (!domainRuleAllows(policy, domain)) {
            await putNetwork(target, { policy: { ...policy, outbound: [{ action: 'allow', target: domain, ports: '', proto: 'all', enabled: true }, ...policy.outbound] }, confirmRisk: body.confirmRisk });
            return;
        }
        sendJson(res, 200, await networkPayload(target));
    }

    async function postExpose(target, body) {
        const policy = readPolicy(target.id);
        const entry = { bind: body.bind, hostPort: body.hostPort, port: body.port };
        const next = normalizePolicy({ ...policy, expose: [...policy.expose, entry] });
        const risks = pendingRisks(policy, next);
        if (risks.length && body.confirmRisk !== true) {
            sendJson(res, 400, { error: '绑定非本机地址会让局域网 / 公网可见，需要确认', needsConfirm: true, risks });
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

    // 状态目录先于容器创建（docker run 之前），刚建的目录不能当孤儿：5 分钟内的一律跳过
    function isYoung(id) {
        const created = Date.parse(state_.readMeta(homeDir, id).createdAt || '');
        return Number.isFinite(created) && Date.now() - created < 5 * 60 * 1000;
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
        const orphans = state_.findOrphans(homeDir, live).filter(id => !isYoung(id)).map(id => {
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
                if (isYoung(id)) {
                    sendJson(res, 409, { error: '这个状态目录刚创建，可能对应一个正在创建的容器，请稍后再试' });
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
                if (ifMatch === undefined) {
                    sendJson(res, 428, { error: '需要 If-Match（先 GET 取得 etag），避免覆盖容器内的修改' });
                    return;
                }
                try {
                    if (body.files !== undefined) state_.normalizeEnvFileList(body.files);
                    state_.writeEnv(homeDir, target.id, body.text, { ifMatch: String(ifMatch).replace(/"/g, ''), parseEnvEntry });
                    if (body.files !== undefined) state_.writeEnvFileList(homeDir, target.id, body.files);
                    else state_.syncFilesEnv(homeDir, target.id);
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
            match: p => p.match(/^\/api\/containers\/([^/]+)\/network\/allow$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                const body = await readJsonBody(req);
                try {
                    await postAllow(target, body);
                } catch (e) {
                    if (res.headersSent) throw e;
                    sendJson(res, 400, { error: e.message });
                }
            }
        },
        {
            method: 'DELETE',
            match: p => p.match(/^\/api\/containers\/([^/]+)\/network\/denied$/),
            handler: async match => {
                const target = resolveTarget(match[1], { write: true });
                if (!target) return;
                deniedLib.clear(egressPaths(homeDir).denied, target.id);
                sendJson(res, 200, await networkPayload(target));
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
