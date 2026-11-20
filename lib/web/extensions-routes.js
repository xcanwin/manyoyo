'use strict';

const os = require('os');
const store = require('../extensions-store');

// 宿主级共享技能 / MCP 的 CRUD 接口。全部挂在全局认证网关之后（非 GET 由 handleWebApi 统一校验 CSRF）。
// 密钥只出不带明文：列表 / 详情都只给 key + 末 4 位；command / args / 完整 URL 只在已认证的详情里给。
function createSharedExtensionsRoutes({ ctx, req, res, deps }) {
    const { sendJson, readJsonBody } = deps;
    const homeDir = ctx.homeDir || os.homedir();

    function normalizePathParam(value) {
        try {
            return decodeURIComponent(String(value || ''));
        } catch (e) {
            return '';
        }
    }

    function fail(e) {
        sendJson(res, 400, { error: e && e.message ? e.message : '请求不合法' });
    }

    return [
        {
            method: 'GET',
            match: path => path === '/api/extensions' ? [] : null,
            handler: async () => {
                sendJson(res, 200, { skills: store.listSkills(homeDir), mcp: store.listMcp(homeDir) });
            }
        },
        {
            method: 'GET',
            match: path => path.match(/^\/api\/extensions\/skills\/([^/]+)\/([^/]+)$/),
            handler: async match => {
                try {
                    sendJson(res, 200, store.readSkill(homeDir, normalizePathParam(match[1]), normalizePathParam(match[2])));
                } catch (e) {
                    sendJson(res, 404, { error: '技能不存在' });
                }
            }
        },
        {
            method: 'POST',
            match: path => path === '/api/extensions/skills' ? [] : null,
            handler: async () => {
                const body = await readJsonBody(req);
                try {
                    const saved = store.writeSkill(homeDir, body.agent, body.name, body.content);
                    sendJson(res, 200, saved);
                } catch (e) {
                    fail(e);
                }
            }
        },
        {
            method: 'PUT',
            match: path => path.match(/^\/api\/extensions\/skills\/([^/]+)\/([^/]+)$/),
            handler: async match => {
                const body = await readJsonBody(req);
                try {
                    sendJson(res, 200, store.writeSkill(homeDir, normalizePathParam(match[1]), normalizePathParam(match[2]), body.content));
                } catch (e) {
                    fail(e);
                }
            }
        },
        {
            method: 'DELETE',
            match: path => path.match(/^\/api\/extensions\/skills\/([^/]+)\/([^/]+)$/),
            handler: async match => {
                try {
                    store.deleteSkill(homeDir, normalizePathParam(match[1]), normalizePathParam(match[2]));
                    sendJson(res, 200, { deleted: true });
                } catch (e) {
                    sendJson(res, 404, { error: '技能不存在' });
                }
            }
        },
        {
            method: 'GET',
            match: path => {
                const m = path.match(/^\/api\/extensions\/mcp\/([^/]+)$/);
                return m && !path.endsWith('/test') ? m : null;
            },
            handler: async match => {
                const item = store.getMcp(homeDir, normalizePathParam(match[1]));
                if (!item) {
                    sendJson(res, 404, { error: 'MCP 不存在' });
                    return;
                }
                sendJson(res, 200, item);
            }
        },
        {
            method: 'POST',
            match: path => path === '/api/extensions/mcp' ? [] : null,
            handler: async () => {
                const body = await readJsonBody(req);
                try {
                    sendJson(res, 200, store.saveMcp(homeDir, body));
                } catch (e) {
                    fail(e);
                }
            }
        },
        {
            method: 'PUT',
            match: path => path.match(/^\/api\/extensions\/mcp\/([^/]+)$/),
            handler: async match => {
                const body = await readJsonBody(req);
                try {
                    sendJson(res, 200, store.saveMcp(homeDir, body, normalizePathParam(match[1])));
                } catch (e) {
                    fail(e);
                }
            }
        },
        {
            method: 'DELETE',
            match: path => path.match(/^\/api\/extensions\/mcp\/([^/]+)$/),
            handler: async match => {
                try {
                    store.deleteMcp(homeDir, normalizePathParam(match[1]));
                    sendJson(res, 200, { deleted: true });
                } catch (e) {
                    sendJson(res, 404, { error: 'MCP 不存在' });
                }
            }
        }
    ];
}

module.exports = { createSharedExtensionsRoutes };
