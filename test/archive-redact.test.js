'use strict';

const redact = require('../lib/archive/redact');

describe('lib/archive/redact', () => {
    test('codex config.toml：只清带引号的字符串值；数字设置和“指向环境变量名”的 env_key 不动', () => {
        const text = 'model_auto_compact_token_limit = 200000\nenv_key = "OPENAI_API_KEY"\napi_token = "abc-secret-1" # 注释\n[mcp_servers.x.env]\nNOTION_TOKEN = "secret_x1"\nname = "ok"\n';
        const out = redact.redactFieldFile('/root/.codex/config.toml', text);
        expect(out.text).toBe('model_auto_compact_token_limit = 200000\nenv_key = "OPENAI_API_KEY"\napi_token = "" # 注释\n[mcp_servers.x.env]\nNOTION_TOKEN = ""\nname = "ok"\n');
        expect(out.removed).toEqual(['abc-secret-1', 'secret_x1']);
    });

    test('claude 的 .claude.json / settings.json：mcpServers 里的 env 和 headers（含项目下的）里的密钥也清空', () => {
        const projects = { '/w': { mcpServers: { notion: { command: 'x', env: { NOTION_TOKEN: 'secret_xxxxxxxx', LANG: 'zh' }, headers: { Authorization: 'Bearer abc12345' } } } } };
        const json = redact.redactFieldFile('/root/.claude.json', JSON.stringify({ primaryApiKey: 'sk-aaaaaaaaaaaaaaaaaaaa', projects }));
        const data = JSON.parse(json.text);
        expect(data.projects['/w'].mcpServers.notion.env).toEqual({ NOTION_TOKEN: '', LANG: 'zh' });
        expect(data.projects['/w'].mcpServers.notion.headers).toEqual({ Authorization: '' });
        expect(json.removed).toEqual(expect.arrayContaining(['secret_xxxxxxxx', 'Bearer abc12345', 'sk-aaaaaaaaaaaaaaaaaaaa']));
        const settings = redact.redactFieldFile('/root/.claude/settings.json', JSON.stringify({ mcpServers: { a: { env: { MY_TOKEN: 'tok-12345678' } } }, env: { ANTHROPIC_AUTH_TOKEN: 'x-12345678' } }));
        expect(JSON.parse(settings.text)).toEqual({ mcpServers: { a: { env: { MY_TOKEN: '' } } }, env: { ANTHROPIC_AUTH_TOKEN: '' } });
    });

    describe('SecretScrubber', () => {
        test('常见密钥格式前面紧挨字母数字的不是密钥（risk-assessment-framework-docs、task-… 这类普通词不能被误删）', () => {
            const scrubber = new redact.SecretScrubber();
            expect(scrubber.scrub('see risk-assessment-framework-docs and disk-cleanup-script-v2 and ask-the-team-about-things')).toBe('see risk-assessment-framework-docs and disk-cleanup-script-v2 and ask-the-team-about-things');
            expect(scrubber.scrub('key=sk-abcdefghijklmnop12345 end (sk-ant-api03-ABCDEFGHIJKLMNOP)')).toBe('key= end ()');
            expect(scrubber.scrub('token ghp_abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP')).toBe('token  and ');
        });

        test('含引号 / 反斜杠的密钥：JSON 转义后的写法和纯文本里的原文都要抹掉', () => {
            const value = 'pa"ss\\word123';
            const scrubber = new redact.SecretScrubber([value]);
            const asJson = JSON.stringify({ text: `my password is ${value}` });
            expect(scrubber.scrub(asJson)).toBe('{"text":"my password is "}');
            expect(scrubber.scrub(`plain log: ${value} end`)).toBe('plain log:  end');
        });

        test('路径、不带账号的网址、太短的值不当密钥抹（SSH_AUTH_SOCK=/run/… 之类）；带密码的网址里的密码才算', () => {
            const scrubber = new redact.SecretScrubber(['/run/user/1000/keyring/ssh', 'https://api.example.com/v1', 'short', 'real-secret-value']);
            expect(scrubber.size).toBe(1);
            expect(scrubber.scrub('sock /run/user/1000/keyring/ssh base https://api.example.com/v1 short real-secret-value')).toBe('sock /run/user/1000/keyring/ssh base https://api.example.com/v1 short ');
            expect([...new redact.SecretScrubber(redact.secretValuesOfEnv({ DB_URL: 'postgres://u:pw-1234567@h/db', AUTH_BASE: 'https://x.example.com' })).values]).toEqual(['pw-1234567']);
        });
    });
});
