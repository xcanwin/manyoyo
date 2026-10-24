'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { __testing } = require('../lib/web/server');
const { BUILTIN_AGENT_INSTRUCTIONS, buildAgentInstructions, composeSystemPrompt } = require('../lib/agent-instructions');

const { buildWebAgentExecCommand } = __testing;

// 让命令真的过一遍 bash：用假的 claude / codex 把收到的参数按 JSON 打出来，
// 断言环境说明作为“一个完整参数”原样到达，引号、$、反引号、换行都不会被 shell 解释
function runWithFakeProgram(program, command) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-instr-'));
    const bin = path.join(dir, program);
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`);
    fs.chmodSync(bin, 0o755);
    try {
        const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const TRICKY = `用户说明：'单引号' "双引号" $HOME \`whoami\` \\反斜杠\n第二行 {prompt} 结束`;

describe('环境说明的内容', () => {
    test('内置说明简短，只写环境事实', () => {
        expect(BUILTIN_AGENT_INSTRUCTIONS.length).toBeLessThanOrEqual(400);
        expect(BUILTIN_AGENT_INSTRUCTIONS).toContain('![');
    });

    test('没有用户说明时只有内置说明；全局说明追加在后面；runs.<name> 覆盖全局', () => {
        expect(buildAgentInstructions({}, '')).toBe(BUILTIN_AGENT_INSTRUCTIONS);
        expect(buildAgentInstructions({ agentInstructions: '全局' }, '')).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n全局`);
        const config = { agentInstructions: '全局', runs: { dev: { agentInstructions: '运行配置' } } };
        expect(buildAgentInstructions(config, 'dev')).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n运行配置`);
        expect(buildAgentInstructions(config, 'other')).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n全局`);
    });

    test('默认不提 MANYOYO；两段各有开关，初始内容 = 默认 + 补充 + 换行', () => {
        expect(BUILTIN_AGENT_INSTRUCTIONS).not.toMatch(/manyoyo/i);
        expect(BUILTIN_AGENT_INSTRUCTIONS).toContain('网页');
        expect(composeSystemPrompt({ agentInstructions: '补充' }, '')).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n补充\n`);
        expect(composeSystemPrompt({ agentInstructions: '补充', agentInstructionsBuiltinEnabled: false }, '')).toBe('补充\n');
        expect(composeSystemPrompt({ agentInstructions: '补充', agentInstructionsCustomEnabled: false }, '')).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n`);
        expect(composeSystemPrompt({ agentInstructionsBuiltinEnabled: false, agentInstructionsCustomEnabled: false }, '')).toBe('');
    });

    test('容器自己存过的提示词优先于系统设置；关掉就不注入', () => {
        const config = { agentInstructions: '全局' };
        expect(buildAgentInstructions(config, '', { enabled: true, text: '容器专属\n' })).toBe('容器专属');
        expect(buildAgentInstructions(config, '', { enabled: false, text: '容器专属' })).toBe('');
    });

    test('去掉控制字符（保留换行和制表符），{prompt} 不会被当成占位符', () => {
        const text = buildAgentInstructions({ agentInstructions: 'a\u0000b\u007fc\td\ne {prompt}' }, '');
        expect(text.endsWith('abc\td\ne { prompt }')).toBe(true);
    });
});

describe('Web 端执行命令注入环境说明', () => {
    const instructions = buildAgentInstructions({ agentInstructions: TRICKY }, '');

    test('claude：作为 --append-system-prompt 的一个完整参数到达，提示词不受影响', () => {
        const command = buildWebAgentExecCommand('claude -p {prompt}', '你好 {prompt}', 'claude', { instructions });
        const argv = runWithFakeProgram('claude', command);
        const index = argv.indexOf('--append-system-prompt');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(argv[index + 1]).toBe(instructions);
        expect(argv[argv.length - 1]).toBe('你好 {prompt}');
    });

    test('claude：模板里已经写了 --append-system-prompt(-file) 时不再注入', () => {
        for (const flag of ['--append-system-prompt mine', '--append-system-prompt-file /x.md']) {
            const command = buildWebAgentExecCommand(`claude ${flag} -p {prompt}`, 'hi', 'claude', { instructions });
            const argv = runWithFakeProgram('claude', command);
            expect(argv.filter(arg => arg.startsWith('--append-system-prompt'))).toHaveLength(1);
            expect(argv).not.toContain(instructions);
        }
    });

    test('codex：-c developer_instructions=<TOML 字符串>，值能按 JSON 解析回原文；续接时同样带上', () => {
        for (const sessionId of ['', '0199aaaa-bbbb-cccc-dddd-eeeeffff0000']) {
            const command = buildWebAgentExecCommand('codex exec --skip-git-repo-check {prompt}', 'hi', 'codex', { instructions, sessionId });
            const argv = runWithFakeProgram('codex', command);
            const index = argv.indexOf('-c');
            expect(index).toBeGreaterThanOrEqual(0);
            const value = argv[index + 1];
            expect(value.startsWith('developer_instructions=')).toBe(true);
            expect(JSON.parse(value.slice('developer_instructions='.length))).toBe(instructions);
            expect(argv[argv.length - 1]).toBe('hi');
        }
    });

    test('codex：模板里已有 developer_instructions 时不再注入', () => {
        const command = buildWebAgentExecCommand(`codex exec -c 'developer_instructions="mine"' {prompt}`, 'hi', 'codex', { instructions });
        const argv = runWithFakeProgram('codex', command);
        expect(argv.filter(arg => arg.startsWith('developer_instructions='))).toEqual(['developer_instructions="mine"']);
    });

    test('识别不出程序的模板不注入', () => {
        const command = buildWebAgentExecCommand('my-agent --ask {prompt}', 'hi', 'unknown', { instructions });
        expect(command).not.toContain('append-system-prompt');
        expect(command).not.toContain('developer_instructions');
    });

    test('没传 instructions 时命令与原来一致', () => {
        expect(buildWebAgentExecCommand('claude -p {prompt}', 'hi', 'claude', {})).not.toContain('--append-system-prompt');
        expect(buildWebAgentExecCommand('codex exec {prompt}', 'hi', 'codex', {})).not.toContain('developer_instructions');
    });
});

describe('opencode：经 OPENCODE_CONFIG_CONTENT 追加一个说明文件（与用户自己的 instructions 合并）', () => {
    function runOpenCode(command, env = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-oc-'));
        const bin = path.join(dir, 'opencode');
        fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const content = process.env.OPENCODE_CONFIG_CONTENT || '';
let file = '';
try { file = fs.readFileSync(JSON.parse(content).instructions[0], 'utf8'); } catch {}
process.stdout.write(JSON.stringify({ content, file, argv: process.argv.slice(2) }));
`);
        fs.chmodSync(bin, 0o755);
        try {
            const tmp = path.join(dir, 'tmp');
            fs.mkdirSync(tmp);
            const result = spawnSync('bash', ['-c', command.replace(/\/tmp\//g, `${tmp}/`)], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
            expect(result.status).toBe(0);
            return JSON.parse(result.stdout);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    const instructions = buildAgentInstructions({ agentInstructions: TRICKY }, '');

    test('说明写进文件并通过环境变量交给 opencode，提示词照常是最后一个参数', () => {
        const out = runOpenCode(buildWebAgentExecCommand('opencode run {prompt}', 'hi', 'opencode', { instructions }));
        expect(out.file).toBe(instructions);
        expect(out.argv[out.argv.length - 1]).toBe('hi');
    });

    test('用户已经设置了 OPENCODE_CONFIG_CONTENT 时不覆盖', () => {
        const out = runOpenCode(buildWebAgentExecCommand('opencode run {prompt}', 'hi', 'opencode', { instructions }), { OPENCODE_CONFIG_CONTENT: '{"model":"x"}' });
        expect(out.content).toBe('{"model":"x"}');
    });
});

test('opencode：识别不出 opencode run 的模板不注入', () => {
    const instructions = buildAgentInstructions({}, '');
    expect(buildWebAgentExecCommand('opencode serve {prompt}', 'hi', 'opencode', { instructions })).not.toContain('OPENCODE_CONFIG_CONTENT');
});

describe('审查回归：说明内容不能影响其他参数，提示词里的 $ 不能被当成替换模式', () => {
    test('说明里写了 -r、--verbose、--model 等字样，续接参数和输出格式照常注入', () => {
        const instructions = buildAgentInstructions({ agentInstructions: '删除用 rm -r x，调试加 --verbose，换 --model 也行 --output-format' }, '');
        const sessionId = '0d6c1f6a-1111-4a2b-9c3d-123456789abc';
        const argv = runWithFakeProgram('claude', buildWebAgentExecCommand('claude -p {prompt}', 'hi', 'claude', { instructions, sessionId, model: 'm1' }));
        expect(argv[argv.indexOf('-r') + 1]).toBe(sessionId);
        expect(argv).toContain('--verbose');
        expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
        expect(argv[argv.indexOf('--model') + 1]).toBe('m1');
    });

    test("提示词里的 $' $` $& 原样到达", () => {
        const prompt = "echo $'a' $` $& 结束";
        for (const [program, template] of [['claude', 'claude -p {prompt}'], ['codex', 'codex exec {prompt}']]) {
            const argv = runWithFakeProgram(program, buildWebAgentExecCommand(template, prompt, program, { instructions: buildAgentInstructions({}, '') }));
            expect([program, argv[argv.length - 1]]).toEqual([program, prompt]);
        }
    });
});

describe('Codex 兼容服务：OPENAI_BASE_URL 要变成自定义 model_provider', () => {
    test('网页对话的 codex exec / exec resume 命令都带上由 shell 展开的占位，不把地址拼进命令', () => {
        const first = buildWebAgentExecCommand('codex exec --skip-git-repo-check {prompt}', 'hi', 'codex', {});
        const resumed = buildWebAgentExecCommand('codex exec --skip-git-repo-check {prompt}', 'hi', 'codex', { sessionId: 'sess-1' });
        for (const command of [first, resumed]) {
            expect(command).toContain('${OPENAI_BASE_URL:+-c model_provider=manyoyo');
            expect(command).toContain('model_providers.manyoyo.env_key=OPENAI_API_KEY');
            expect(command).not.toMatch(/https?:\/\//);
        }
        expect(resumed).toContain('exec resume');
    });

    // codex 不允许 --model 出现两次：会话里选了模型就以它为准，不再追加环境变量里的
    test('会话里选了模型时只有一个 --model', () => {
        const picked = buildWebAgentExecCommand('codex exec --skip-git-repo-check {prompt}', 'hi', 'codex', { model: 'picked-model' });
        expect(picked.match(/--model/g)).toHaveLength(1);
        expect(picked).toContain("--model 'picked-model'");
        expect(picked).not.toContain('OPENAI_MODEL');
        const none = buildWebAgentExecCommand('codex exec --skip-git-repo-check {prompt}', 'hi', 'codex', {});
        expect(none).toContain('${OPENAI_MODEL:+--model "$OPENAI_MODEL"}');
    });

    test('用户模板里已经写了 openai_base_url 就以用户的为准；非 codex 的命令不受影响', () => {
        const own = buildWebAgentExecCommand(`codex exec -c 'openai_base_url="http://mine"' {prompt}`, 'hi', 'codex', {});
        expect(own).not.toContain('OPENAI_BASE_URL');
        expect(buildWebAgentExecCommand('claude -p {prompt}', 'hi', 'claude', {})).not.toContain('OPENAI_BASE_URL');
    });
});
