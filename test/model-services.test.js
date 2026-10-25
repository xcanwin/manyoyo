'use strict';

const JSON5 = require('json5');
const {
    listModelServices,
    suggestReuse,
    buildNewService,
    buildReuseService,
    buildServiceEdit,
    applyConfigOps,
    assertOpsApplied,
    keyTail
} = require('../lib/model-services');

const GLM_KEY = 'glm-secret-key-aaaa1111';
const DS_KEY = 'ds-secret-key-bbbb2222';

// 模仿真实配置：运行配置不叫 claude / codex，env 里有数字值，带注释
const RAW = `{
    // 全局注释
    "serve": { "quickChat": { "run": "claude-ds" } },
    "runs": {
        "claude-glm": {
            "containerName": "my-claude-glm-{now}",
            "yolo": "c",
            "env": {
                "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
                "ANTHROPIC_AUTH_TOKEN": "${GLM_KEY}",
                "API_TIMEOUT_MS": 3000000
            }
        },
        "claude-ds": {
            "yolo": "cc",
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "${DS_KEY}",
                "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic/", // 30分钟
                "ANTHROPIC_MODEL": "deepseek-flash[1m]"
            }
        },
        "mine": { "yolo": "c", "env": { "ANTHROPIC_AUTH_TOKEN": "x-custom-key-1234", "ANTHROPIC_BASE_URL": "https://llm.example.com" } },
        "no-key": { "yolo": "c", "env": {} }
    }
}
`;
const config = JSON5.parse(RAW);

describe('listModelServices', () => {
    test('认出任意名字的运行配置、服务商和 Agent，没有 Key 的不列', () => {
        const list = listModelServices(config);
        expect(list.map(item => item.name)).toEqual(['claude-glm', 'claude-ds', 'mine']);
        const byName = Object.fromEntries(list.map(item => [item.name, item]));
        expect(byName['claude-glm']).toMatchObject({ agent: 'claude', providerId: 'zhipu', providerLabel: '智谱 GLM', keyTail: '…1111' });
        // Base URL 末尾多一个斜杠也认得出
        expect(byName['claude-ds']).toMatchObject({ providerId: 'deepseek', model: 'deepseek-flash[1m]' });
        expect(byName.mine).toMatchObject({ providerId: '', providerLabel: '自定义地址' });
    });

    test('响应里没有 Key 本身', () => {
        const text = JSON.stringify({ list: listModelServices(config), suggestions: suggestReuse(config) });
        expect(text).not.toContain(GLM_KEY);
        expect(text).not.toContain(DS_KEY);
        expect(text).not.toContain('x-custom-key');
    });
});

describe('缺少服务商必需的附加变量', () => {
    test('智谱的 Claude 运行配置没有 ENABLE_TOOL_SEARCH=false 时标出来，DeepSeek 不用；一键修复只补这一个变量', () => {
        const byName = Object.fromEntries(listModelServices(config).map(item => [item.name, item]));
        expect(byName['claude-glm'].missingExtraEnv).toEqual({ ENABLE_TOOL_SEARCH: 'false' });
        expect(byName['claude-ds'].missingExtraEnv).toEqual({});
        expect(byName.mine.missingExtraEnv).toEqual({});
        const { ops } = buildServiceEdit(config, 'claude-glm', { applyPresetExtras: true });
        expect(ops).toEqual([{ type: 'set', path: ['runs', 'claude-glm', 'env', 'ENABLE_TOOL_SEARCH'], value: 'false' }]);
        const fixed = JSON5.parse(applyConfigOps(RAW, ops));
        expect(fixed.runs['claude-glm'].env).toEqual({ ...config.runs['claude-glm'].env, ENABLE_TOOL_SEARCH: 'false' });
        expect(listModelServices(fixed).find(item => item.name === 'claude-glm').missingExtraEnv).toEqual({});
        // 值不对（用户写成 true）也要修
        const wrong = JSON5.parse(RAW);
        wrong.runs['claude-glm'].env.ENABLE_TOOL_SEARCH = 'true';
        expect(listModelServices(wrong).find(item => item.name === 'claude-glm').missingExtraEnv).toEqual({ ENABLE_TOOL_SEARCH: 'false' });
    });
});

describe('suggestReuse', () => {
    test('智谱和 DeepSeek 的 Key 也能给 Codex 用；自定义地址不建议', () => {
        const list = suggestReuse(config);
        expect(list.map(item => `${item.from}->${item.agent}:${item.providerId}`)).toEqual(['claude-glm->codex:zhipu', 'claude-ds->codex:deepseek']);
        expect(list[0].label).toBe('智谱 GLM 的 Key 也能给 Codex CLI 用');
    });

    test('已经有用同一个 Key 的 Codex 服务就不再建议', () => {
        const next = JSON5.parse(RAW);
        next.runs['codex-glm'] = { yolo: 'cx', env: { OPENAI_API_KEY: GLM_KEY, OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/v1', OPENAI_MODEL: 'glm-5.3' } };
        expect(suggestReuse(next).map(item => item.providerId)).toEqual(['deepseek']);
    });
});

describe('buildReuseService / buildNewService', () => {
    test('复用智谱 Key 给 Codex：同一个 Key，地址和模型按预设，名字不冲突，不改原来的', () => {
        const { name, profile } = buildReuseService(config, 'claude-glm', 'codex');
        expect(name).toBe('codex-zhipu');
        expect(profile.yolo).toBe('cx');
        expect(profile.env).toEqual({ OPENAI_API_KEY: GLM_KEY, OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/v1', OPENAI_MODEL: 'glm-5.3' });
        const taken = JSON5.parse(RAW);
        taken.runs['codex-zhipu'] = { yolo: 'cx', env: {} };
        expect(buildReuseService(taken, 'claude-glm', 'codex').name).toBe('codex-zhipu-2');
    });

    test('新增 / 复用都不把默认工作目录根写进运行配置（否则新建容器会把整个工作目录根挂进去，对话框里目录还是空白）', () => {
        const root = '/home/u/.manyoyo/work';
        expect(buildNewService(config, { agent: 'codex', providerId: 'zhipu', key: 'k-123456' }, { defaultHostPath: root }).profile.hostPath).toBeUndefined();
        const withRoot = JSON5.parse(RAW);
        withRoot.runs['claude-glm'].hostPath = root;
        expect(buildReuseService(withRoot, 'claude-glm', 'codex', { defaultHostPath: root }).profile.hostPath).toBeUndefined();
        // 用户给原来那套指定过自己的项目目录：复用时照抄
        const withProject = JSON5.parse(RAW);
        withProject.runs['claude-glm'].hostPath = '/projects/app';
        expect(buildReuseService(withProject, 'claude-glm', 'codex', { defaultHostPath: root }).profile.hostPath).toBe('/projects/app');
    });

    test('新增：Claude 智谱自动带 ENABLE_TOOL_SEARCH=false；DeepSeek 不带；自定义地址的 Codex 必须有模型', () => {
        expect(buildNewService(config, { agent: 'claude', providerId: 'zhipu', key: 'k-123456' }).profile.env)
            .toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'k-123456', ENABLE_TOOL_SEARCH: 'false' });
        expect(buildNewService(config, { agent: 'claude', providerId: 'deepseek', key: 'k-123456' }).profile.env)
            .not.toHaveProperty('ENABLE_TOOL_SEARCH');
        expect(() => buildNewService(config, { agent: 'codex', baseUrl: 'https://x.test/v1', key: 'k-123456' })).toThrow(/模型/);
        expect(buildNewService(config, { agent: 'codex', baseUrl: 'https://x.test/v1', key: 'k-123456', model: 'm1' }).name).toBe('codex-custom');
    });

    test('校验：重名、非法名字、非法值、没有这家的预设、空 Key', () => {
        expect(() => buildNewService(config, { agent: 'claude', providerId: 'zhipu', key: 'k-123456', name: 'claude-glm' })).toThrow(/已有/);
        expect(() => buildNewService(config, { agent: 'claude', providerId: 'zhipu', key: 'k-123456', name: '../x' })).toThrow(/名字/);
        expect(() => buildNewService(config, { agent: 'claude', providerId: 'zhipu', key: 'a;b' })).toThrow();
        expect(() => buildNewService(config, { agent: 'codex', providerId: 'aliyun', key: 'k-123456' })).toThrow(/预设/);
        expect(() => buildNewService(config, { agent: 'claude', providerId: 'zhipu', key: '  ' })).toThrow(/Key/);
        expect(() => buildNewService(config, { agent: 'nope', key: 'k' })).toThrow(/不支持/);
    });

    test('订阅令牌：只有 Claude 支持，不带 Base URL', () => {
        const { profile } = buildNewService(config, { agent: 'claude', subscription: true, key: 'oauth-token-123456' });
        expect(profile.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123456' });
        expect(() => buildNewService(config, { agent: 'codex', subscription: true, key: 'x' })).toThrow();
    });
});

describe('buildServiceEdit + applyConfigOps', () => {
    test('换 Key 只动这一个变量，其它运行配置和注释原样保留', () => {
        const { ops } = buildServiceEdit(config, 'claude-ds', { key: 'ds-new-key-9999' });
        const out = applyConfigOps(RAW, ops);
        const parsed = JSON5.parse(out);
        expect(parsed.runs['claude-ds'].env.ANTHROPIC_AUTH_TOKEN).toBe('ds-new-key-9999');
        expect(parsed.runs['claude-glm']).toEqual(config.runs['claude-glm']);
        expect(out).toContain('// 全局注释');
        expect(out).toContain('// 30分钟');
    });

    test('key 留空表示不改；清空模型会删掉该变量', () => {
        expect(buildServiceEdit(config, 'claude-ds', { key: '', model: 'deepseek-flash[1m]' }).ops.map(o => o.path.join('.'))).toEqual(['runs.claude-ds.env.ANTHROPIC_MODEL']);
        const { ops } = buildServiceEdit(config, 'claude-ds', { model: '' });
        const parsed = JSON5.parse(applyConfigOps(RAW, ops));
        expect(parsed.runs['claude-ds'].env).not.toHaveProperty('ANTHROPIC_MODEL');
        expect(parsed.runs['claude-ds'].env.ANTHROPIC_AUTH_TOKEN).toBe(DS_KEY);
    });

    test('Claude 的档位 / 子 Agent 模型：只认白名单键，空值删除，别的变量不动', () => {
        const edited = applyConfigOps(RAW, buildServiceEdit(config, 'claude-ds', {
            models: { ANTHROPIC_DEFAULT_OPUS_MODEL: ' big ', CLAUDE_CODE_SUBAGENT_MODEL: 'small' }
        }).ops);
        const env = JSON5.parse(edited).runs['claude-ds'].env;
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('big');
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('small');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(DS_KEY);
        expect(() => buildServiceEdit(config, 'claude-ds', { models: { ANTHROPIC_AUTH_TOKEN: 'x' } })).toThrow();
        const cfg2 = JSON5.parse(edited);
        const removed = JSON5.parse(applyConfigOps(edited, buildServiceEdit(cfg2, 'claude-ds', { models: { ANTHROPIC_DEFAULT_OPUS_MODEL: '' } }).ops));
        expect(removed.runs['claude-ds'].env).not.toHaveProperty('ANTHROPIC_DEFAULT_OPUS_MODEL');
        expect(removed.runs['claude-ds'].env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('small');
    });

    test('autoCompact1m：true 写 1000000，false 删除', () => {
        const on = JSON5.parse(applyConfigOps(RAW, buildServiceEdit(config, 'claude-ds', { autoCompact1m: true }).ops));
        expect(on.runs['claude-ds'].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
        const off = JSON5.parse(applyConfigOps(JSON.stringify(on), buildServiceEdit(on, 'claude-ds', { autoCompact1m: false }).ops));
        expect(off.runs['claude-ds'].env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
        expect(buildServiceEdit(config, 'claude-ds', { autoCompact1m: false }).ops).toEqual([]);
    });

    test('Codex 服务不接受 models / autoCompact1m', () => {
        const codexConfig = { runs: { 'codex-z': { yolo: 'cx', env: { OPENAI_API_KEY: 'k-1234567890', OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4', OPENAI_MODEL: 'glm' } } } };
        expect(buildServiceEdit(codexConfig, 'codex-z', { model: 'glm2' }).agent).toBe('codex');
        expect(() => buildServiceEdit(codexConfig, 'codex-z', { models: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'x' } })).toThrow('只支持 Claude');
        expect(() => buildServiceEdit(codexConfig, 'codex-z', { autoCompact1m: true })).toThrow('只支持 Claude');
    });

    test('列表里 Claude 服务带 models 与 autoCompactWindow，Codex 没有', () => {
        const withModels = JSON5.parse(applyConfigOps(RAW, buildServiceEdit(config, 'claude-ds', { models: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h' }, autoCompact1m: true }).ops));
        const ds = listModelServices(withModels).find(item => item.name === 'claude-ds');
        expect(ds.models).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', ANTHROPIC_DEFAULT_FABLE_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL: '' });
        expect(ds.autoCompactWindow).toBe('1000000');
        expect(listModelServices({ runs: { 'codex-z': { yolo: 'cx', env: { OPENAI_API_KEY: 'k-1234567890' } } } })[0]).not.toHaveProperty('models');
    });

    test('保存订阅令牌后，同一个运行配置里的 API Key 类变量和 Base URL 被删掉', () => {
        const { ops } = buildServiceEdit(config, 'claude-glm', { key: 'oauth-token-123456', subscription: true });
        const env = JSON5.parse(applyConfigOps(RAW, ops)).runs['claude-glm'].env;
        expect(env).toEqual({ API_TIMEOUT_MS: 3000000, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123456' });
    });

    test('新增运行配置落盘后其余内容不变', () => {
        const { name, profile } = buildReuseService(config, 'claude-glm', 'codex');
        const out = applyConfigOps(RAW, [{ type: 'set', path: ['runs', name], value: profile }]);
        const parsed = JSON5.parse(out);
        expect(parsed.runs['codex-zhipu'].env.OPENAI_API_KEY).toBe(GLM_KEY);
        expect(parsed.runs['claude-ds']).toEqual(config.runs['claude-ds']);
        expect(out).toContain('// 30分钟');
    });

    test('找不到的服务报错', () => {
        expect(() => buildServiceEdit(config, 'nope', { key: 'k-123456' })).toThrow(/找不到/);
    });
});

describe('审查发现的边角', () => {
    test('不存在或不是对象的运行配置不会被名字前缀认成服务，编辑报“找不到”而不是崩', () => {
        const odd = { runs: { 'claude-null': null, 'claude-str': 'x', real: config.runs.mine } };
        expect(listModelServices(odd).map(item => item.name)).toEqual(['real']);
        expect(() => buildServiceEdit(config, 'claude-x', { key: 'k-123456' })).toThrow(/找不到/);
    });

    test('Codex 编辑时清空模型会让“有地址没模型”，拒绝；只换 Key 不受影响', () => {
        const codex = { runs: { 'codex-x': { yolo: 'cx', env: { OPENAI_API_KEY: 'k-123456789012', OPENAI_BASE_URL: 'https://x.test/v1', OPENAI_MODEL: 'm1' } } } };
        expect(() => buildServiceEdit(codex, 'codex-x', { model: '' })).toThrow(/模型/);
        expect(buildServiceEdit(codex, 'codex-x', { model: 'm2' }).ops).toHaveLength(1);
        // 老配置本来就没写模型：只换 Key 不被拦
        delete codex.runs['codex-x'].env.OPENAI_MODEL;
        expect(buildServiceEdit(codex, 'codex-x', { key: 'k-new-123456789' }).ops).toHaveLength(1);
    });

    test('太短的 Key 不显示末 4 位', () => {
        expect(keyTail('12345678')).toBe('…');
        expect(keyTail('123456789012')).toBe('…9012');
        expect(keyTail('')).toBe('');
    });

    test('写盘前核对：键名带转义时局部替换改不到，报错而不是回报成功', () => {
        const raw = '{ runs: { "a\\"b": { yolo: "c", env: { ANTHROPIC_AUTH_TOKEN: "k" } } } }';
        const ops = [{ type: 'remove', path: ['runs', 'a"b'] }];
        expect(() => assertOpsApplied(applyConfigOps(raw, ops), ops)).toThrow(/没能删除/);
        const ok = [{ type: 'set', path: ['runs', 'new'], value: { yolo: 'c' } }];
        expect(() => assertOpsApplied(applyConfigOps(RAW, ok), ok)).not.toThrow();
    });
});
