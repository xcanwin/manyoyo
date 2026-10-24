'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanLocalServices, toPreview, buildImportRuns } = require('../lib/model-service-import');

const ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
const CLAUDE_KEY = 'local-claude-key-aaaa1111';
const CODEX_KEY = 'local-codex-key-bbbb2222';

describe('从本机导入', () => {
    let home;
    let saved;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-import-'));
        saved = {};
        ENV_KEYS.forEach(key => { saved[key] = process.env[key]; delete process.env[key]; });
    });
    afterEach(() => {
        ENV_KEYS.forEach(key => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
        fs.rmSync(home, { recursive: true, force: true });
    });
    const write = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
        fs.writeFileSync(path.join(home, rel), text);
    };

    test('读不到任何东西时返回空', () => {
        expect(scanLocalServices(home, {})).toEqual([]);
    });

    test('从 Claude settings 和 Codex 配置里提取 Key / 地址 / 模型；预览只有 Key 末 4 位', () => {
        write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY, ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.3' } }));
        write('.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: CODEX_KEY, tokens: { refresh_token: 'rt-secret-token', access_token: 'at-secret-token' } }));
        write('.codex/config.toml', 'model = "gpt-x"\nopenai_base_url = "https://api.deepseek.com"\n');
        const candidates = scanLocalServices(home, {});
        expect(candidates.map(item => [item.agent, item.baseUrl, item.model])).toEqual([
            ['claude', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3'],
            ['codex', 'https://api.deepseek.com', 'gpt-x']
        ]);
        const preview = JSON.stringify(toPreview(candidates));
        expect(preview).toContain('…1111');
        expect(preview).toContain('智谱 GLM');
        for (const secret of [CLAUDE_KEY, CODEX_KEY, 'rt-secret-token', 'at-secret-token']) expect(preview).not.toContain(secret);
        // 内部候选也没有 OAuth 令牌
        expect(JSON.stringify(candidates)).not.toContain('rt-secret-token');
    });

    test('只有 Codex 的 OAuth 登录（auth.json 里没有 OPENAI_API_KEY）不算可导入；Claude 的订阅令牌也不导入', () => {
        write('.codex/auth.json', JSON.stringify({ tokens: { refresh_token: 'rt-secret-token' } }));
        write('.claude/settings.json', JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok-123456' } }));
        expect(scanLocalServices(home, {})).toEqual([]);
    });

    test('环境变量也是来源；和已有服务 Key 相同的标成重复', () => {
        process.env.OPENAI_API_KEY = CODEX_KEY;
        const config = { runs: { 'my-codex': { yolo: 'cx', env: { OPENAI_API_KEY: CODEX_KEY } } } };
        const [candidate] = scanLocalServices(home, config);
        expect(candidate).toMatchObject({ agent: 'codex', duplicate: true });
    });

    test('导入只写 env，不带任何挂载；名字冲突加数字，不覆盖已有运行配置', () => {
        write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY, ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' } }));
        write('.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: CODEX_KEY }));
        const config = { runs: { 'claude-zhipu': { yolo: 'c', env: { ANTHROPIC_AUTH_TOKEN: 'someone-else-key' } } } };
        const candidates = scanLocalServices(home, config);
        const built = buildImportRuns(config, candidates, ['claude', 'codex']);
        expect(built.map(item => item.name)).toEqual(['claude-zhipu-2', 'codex-local']);
        for (const { profile } of built) {
            expect(profile).not.toHaveProperty('volumes');
            expect(JSON.stringify(profile)).not.toContain('.codex');
        }
        expect(built[0].profile.env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDE_KEY);
        expect(config.runs['claude-zhipu'].env.ANTHROPIC_AUTH_TOKEN).toBe('someone-else-key');
        expect(() => buildImportRuns(config, candidates, ['gemini'])).toThrow(/没有可导入/);
    });

    test('Codex 有地址没模型的本机配置不能导入；ids 重复只建一条', () => {
        write('.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: CODEX_KEY }));
        write('.codex/config.toml', 'openai_base_url = "https://api.deepseek.com"\n');
        let candidates = scanLocalServices(home, {});
        expect(toPreview(candidates)[0].invalid).toMatch(/模型/);
        write('.codex/config.toml', 'model = "deepseek-flash"\nopenai_base_url = "https://api.deepseek.com"\n');
        candidates = scanLocalServices(home, {});
        expect(buildImportRuns({}, candidates, ['codex', 'codex']).map(item => item.name)).toEqual(['codex-deepseek']);
    });

    test('值里有不允许的字符的不能导入', () => {
        write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'a;b' } }));
        const candidates = scanLocalServices(home, {});
        expect(toPreview(candidates)[0].invalid).toEqual(expect.any(String));
        expect(() => buildImportRuns({}, candidates, ['claude'])).toThrow(/不能导入/);
    });
});
