'use strict';

const light = require('../lib/web/agent-light-call');
const { __testing } = require('../lib/web/server');

describe('轻量调用（lib/web/agent-light-call.js）', () => {
    test('claude 命令：低强度、不留会话、不用工具、规则走系统提示、用户原文是最后一个参数且被转义', () => {
        const input = "改一下 it's a bug; rm -rf / $(id)";
        const command = light.buildClaudeLightCommand({ rule: light.TITLE_RULE, input, model: 'haiku' });
        expect(command).toMatch(/^CLAUDE_CODE_EFFORT_LEVEL=low claude -p --no-session-persistence --tools "" --system-prompt '/);
        expect(command).toContain("--model 'haiku'");
        expect(command).toContain("it'\"'\"'s a bug; rm -rf / $(id)'");
        expect(command.endsWith("$(id)'")).toBe(true);
        expect(light.buildClaudeLightCommand({ rule: 'r', input: 'x', model: '' })).not.toContain('--model');
    });

    test('模型选择：配了小模型别名或官方服务用 haiku，否则用这个 AGENT 选的模型，都没有不传', () => {
        expect(light.pickClaudeLightModel({}, 'glm-5')).toBe('haiku');
        expect(light.pickClaudeLightModel({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-flash' }, 'glm-5')).toBe('haiku');
        expect(light.pickClaudeLightModel({ ANTHROPIC_BASE_URL: 'https://x' }, 'glm-5')).toBe('glm-5');
        expect(light.pickClaudeLightModel({ ANTHROPIC_BASE_URL: 'https://x' }, '')).toBe('');
        expect(light.pickClaudeLightModel({ ANTHROPIC_BASE_URL: 'https://x' }, 'a b;c')).toBe('');
    });

    test('codex 命令：一次性、只读、低强度，规则写进提示词，原文在分隔标记里', () => {
        const prompt = light.buildCodexLightPrompt(light.TITLE_RULE, '你好 "x"');
        const command = __testing.buildCodexAgentExecCommand(light.CODEX_LIGHT_TEMPLATE, prompt, { model: 'glm-5.3' });
        expect(command).toContain('codex exec');
        expect(command).toContain('--json');
        expect(command).toContain('--ephemeral');
        expect(command).toContain('-s read-only');
        expect(command).toContain('model_reasoning_effort=low');
        expect(command).toContain('--skip-git-repo-check');
        expect(command).toContain('<<<材料开始>>>');
        expect(command.match(/model_reasoning_effort/g)).toHaveLength(1);
    });

    test('解析 claude 的 json 输出：取最后一个带 result 的对象，错误结果不算', () => {
        expect(light.parseClaudeLightOutput('noise\n{"type":"result","result":"修复登录"}\n')).toBe('修复登录');
        expect(light.parseClaudeLightOutput('{"result":"a"}\n{"result":"b"}')).toBe('b');
        expect(light.parseClaudeLightOutput('{"result":"出错了","is_error":true}')).toBe('');
        expect(light.parseClaudeLightOutput('')).toBe('');
        expect(light.parseClaudeLightOutput('{bad')).toBe('');
    });

    test('清洗：去引号 / 书名号 / 句号、只取第一行、限长、控制字符变空格；空就是失败', () => {
        expect(light.cleanLightText('“修复登录页面。”\n解释：……', 30)).toBe('修复登录页面');
        expect(light.cleanLightText('《标题》', 30)).toBe('标题');
        expect(light.cleanLightText('一二三四五六七八九十'.repeat(5), 30)).toHaveLength(30);
        expect(light.cleanLightText('a\u0007b', 30)).toBe('a b');
        expect(light.cleanLightText('   \n  ', 30)).toBe('');
        expect(light.cleanLightText('<script>alert(1)</script>', 60)).toBe('<script>alert(1)</script>');
        expect(light.cleanLightText(null, 30)).toBe('');
    });

    test('输入限长', () => {
        expect(Array.from(light.buildTitleInput('字'.repeat(5000)))).toHaveLength(1000);
        const recap = light.buildRecapInput('Q'.repeat(5000), 'Z'.repeat(9000));
        expect(Array.from(recap.match(/Q+/)[0])).toHaveLength(1000);
        expect(Array.from(recap.match(/Z+/)[0])).toHaveLength(3000);
    });
});
