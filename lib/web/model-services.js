'use strict';

const os = require('os');
const containersLib = require('../model-service-containers');
const importLib = require('../model-service-import');
const {
    listModelServices,
    suggestReuse,
    buildNewService,
    buildReuseService,
    buildServiceEdit,
    applyConfigOps,
    assertRunName,
    keyValueOf
} = require('../model-services');
const { AGENT_ENV_SCHEMA } = require('../init-config');
const { providersForAgent } = require('../provider-presets');

// 「模型服务」接口：列表 / 新增（含一键复用）/ 编辑 / 删除 / 测试连接。
// 全部挂在全局认证网关之后，非 GET 由 handleWebApi 统一校验 X-Requested-With。
// 响应里只有 Key 的末 4 位；写配置都是“读当前磁盘 → 局部修改 → 写回”，中间没有 await。
function toObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function createModelServiceRoutes({ ctx, state, req, res, deps }) {
    const { sendJson, readJsonBody, decodeSessionName, readSnapshot, writeRaw, baseRawOf, validateRaw, runConnectionTest, defaultHostPath, listManaged } = deps;
    const homeDir = ctx.homeDir || os.homedir();

    function loadConfig() {
        const snapshot = readSnapshot();
        if (snapshot.parseError) {
            sendJson(res, 400, { error: '当前配置解析失败，无法继续', detail: snapshot.parseError });
            return null;
        }
        return { snapshot, config: snapshot.parsed || {} };
    }

    function saveRaw(nextRaw) {
        validateRaw(nextRaw);
        writeRaw(nextRaw);
    }

    function fail(e, status = 400) {
        sendJson(res, status, { error: e && e.message ? e.message : '参数无效' });
    }

    // 受管容器里还在用这个服务当前 Key 的（按 box/env 里的 Key 相等判断）；运行时查不到就当没有
    async function usingContainers(config, name) {
        const service = listModelServices(config).find(item => item.name === name);
        if (!service) return [];
        try {
            return containersLib.findUsingContainers({
                homeDir,
                containers: await listManaged(),
                keyEnv: service.keyEnv,
                keyValue: keyValueOf(config, name)
            });
        } catch (e) {
            return [];
        }
    }

    function overview(config) {
        const quickRun = config.serve && config.serve.quickChat && typeof config.serve.quickChat.run === 'string' ? config.serve.quickChat.run : '';
        return {
            services: listModelServices(config).map(item => ({ ...item, quickChatDefault: item.name === quickRun })),
            suggestions: suggestReuse(config),
            // 向导里的服务商预设，新增 / 编辑表单据此填地址和模型
            agents: ['claude', 'codex'].map(id => ({
                id,
                label: AGENT_ENV_SCHEMA[id].label,
                providers: providersForAgent(id)
            }))
        };
    }

    return [
        {
            method: 'GET',
            match: p => (p === '/api/model-services' ? [] : null),
            handler: async () => {
                const loaded = loadConfig();
                if (!loaded) return;
                sendJson(res, 200, overview(loaded.config));
            }
        },
        {
            // 本机已有的 Key / 地址 / 模型（只读取不写入；Key 只给末 4 位）
            method: 'GET',
            match: p => (p === '/api/model-services/import-preview' ? [] : null),
            handler: async () => {
                const loaded = loadConfig();
                if (!loaded) return;
                const sources = importLib.IMPORT_AGENTS.map(item => ({ agent: item.id, label: AGENT_ENV_SCHEMA[item.id].label, where: item.sources }));
                sendJson(res, 200, { candidates: importLib.toPreview(importLib.scanLocalServices(homeDir, loaded.config)), sources });
            }
        },
        {
            // 导入选中的候选：{ ids: ['claude', 'codex'] }；服务端重新扫描，不信任前端传来的内容
            method: 'POST',
            match: p => (p === '/api/model-services/import' ? [] : null),
            handler: async () => {
                const body = toObject(await readJsonBody(req));
                const loaded = loadConfig();
                if (!loaded) return;
                let built;
                try {
                    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
                    if (!ids.length) throw new Error('请选择要导入的服务');
                    built = importLib.buildImportRuns(loaded.config, importLib.scanLocalServices(homeDir, loaded.config), ids, { defaultHostPath: defaultHostPath() });
                    saveRaw(applyConfigOps(baseRawOf(loaded.snapshot), built.map(item => ({ type: 'set', path: ['runs', item.name], value: item.profile }))));
                } catch (e) {
                    fail(e);
                    return;
                }
                sendJson(res, 200, { saved: true, names: built.map(item => item.name), ...overview(readSnapshot().parsed || {}) });
            }
        },
        {
            // 新增：{ agent, providerId | baseUrl, key, model?, name? } 或一键复用 { reuseFrom, agent }
            method: 'POST',
            match: p => (p === '/api/model-services' ? [] : null),
            handler: async () => {
                const body = await readJsonBody(req);
                const loaded = loadConfig();
                if (!loaded) return;
                let built;
                try {
                    built = body && body.reuseFrom
                        ? buildReuseService(loaded.config, String(body.reuseFrom), String(body.agent || ''), { defaultHostPath: defaultHostPath() })
                        : buildNewService(loaded.config, body || {}, { defaultHostPath: defaultHostPath() });
                    saveRaw(applyConfigOps(baseRawOf(loaded.snapshot), [{ type: 'set', path: ['runs', built.name], value: built.profile }]));
                } catch (e) {
                    fail(e);
                    return;
                }
                sendJson(res, 200, { saved: true, name: built.name, ...overview(readSnapshot().parsed || {}) });
            }
        },
        {
            // 还在用这个服务当前 Key 的容器（编辑页据此提示“N 个容器还在用旧设置”）
            method: 'GET',
            match: p => p.match(/^\/api\/model-services\/([^/]+)\/containers$/),
            handler: async ([, encoded]) => {
                const name = decodeSessionName(encoded);
                const loaded = loadConfig();
                if (!loaded) return;
                sendJson(res, 200, { containers: (await usingContainers(loaded.config, name)).map(item => item.name) });
            }
        },
        {
            // syncContainers:true 时，把新值一并写进还在用旧 Key 的容器（下一轮对话生效）
            method: 'PUT',
            match: p => p.match(/^\/api\/model-services\/([^/]+)$/),
            handler: async ([, encoded]) => {
                const name = decodeSessionName(encoded);
                const body = toObject(await readJsonBody(req));
                const loaded = loadConfig();
                if (!loaded) return;
                let updatedContainers = [];
                try {
                    const { ops } = buildServiceEdit(loaded.config, name, body);
                    // 先按旧 Key 找容器，再写配置
                    const targets = body.syncContainers === true && ops.length ? await usingContainers(loaded.config, name) : [];
                    if (ops.length) saveRaw(applyConfigOps(baseRawOf(loaded.snapshot), ops));
                    if (targets.length) {
                        const set = {};
                        ops.filter(op => op.type === 'set').forEach(op => { set[op.path[op.path.length - 1]] = op.value; });
                        const remove = ops.filter(op => op.type === 'remove').map(op => op.path[op.path.length - 1]);
                        updatedContainers = containersLib.applyToContainers({ homeDir, targets, set, remove });
                    }
                } catch (e) {
                    fail(e);
                    return;
                }
                sendJson(res, 200, { saved: true, name, updatedContainers, ...overview(readSnapshot().parsed || {}) });
            }
        },
        {
            // 只删配置，不影响已有容器；是快捷对话默认时一并清掉，避免指向不存在的运行配置
            method: 'DELETE',
            match: p => p.match(/^\/api\/model-services\/([^/]+)$/),
            handler: async ([, encoded]) => {
                const name = decodeSessionName(encoded);
                const loaded = loadConfig();
                if (!loaded) return;
                try {
                    assertRunName(name);
                    if (!listModelServices(loaded.config).some(item => item.name === name)) throw new Error(`找不到模型服务: ${name}`);
                    const ops = [{ type: 'remove', path: ['runs', name] }];
                    const quick = loaded.config.serve && loaded.config.serve.quickChat;
                    if (quick && quick.run === name) ops.push({ type: 'remove', path: ['serve', 'quickChat', 'run'] });
                    saveRaw(applyConfigOps(baseRawOf(loaded.snapshot), ops));
                } catch (e) {
                    fail(e);
                    return;
                }
                sendJson(res, 200, { deleted: true, name, ...overview(readSnapshot().parsed || {}) });
            }
        },
        {
            // 用已保存的 Key 测试（Key 不经过浏览器）
            method: 'POST',
            match: p => p.match(/^\/api\/model-services\/([^/]+)\/test$/),
            handler: async ([, encoded]) => {
                const name = decodeSessionName(encoded);
                await readJsonBody(req);
                const loaded = loadConfig();
                if (!loaded) return;
                const service = listModelServices(loaded.config).find(item => item.name === name);
                if (!service) {
                    sendJson(res, 404, { error: `找不到模型服务: ${name}` });
                    return;
                }
                if (state.setupTestRunning) {
                    sendJson(res, 409, { error: '已有连接测试正在进行，请稍后重试' });
                    return;
                }
                const env = {};
                for (const [key, value] of Object.entries(loaded.config.runs[name].env || {})) {
                    if (typeof value === 'string' || typeof value === 'number') env[key] = String(value);
                }
                state.setupTestRunning = true;
                try {
                    sendJson(res, 200, await runConnectionTest(service.agent, env));
                } finally {
                    state.setupTestRunning = false;
                }
            }
        }
    ];
}

module.exports = { createModelServiceRoutes };
