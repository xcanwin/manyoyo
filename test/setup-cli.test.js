'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');
const JSON5 = require('json5');
const { runSetupCli, createPrompter } = require('../lib/setup-cli');

let root;
let configPath;
let logs;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-setup-cli-'));
    configPath = path.join(root, '.manyoyo', 'manyoyo.json');
    logs = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// 脚本化的提示器：normal 与 secret 分两条队列，并记录所有提示文字
function scripted({ answers = [], secrets = [] }) {
    const asked = [];
    const askedSecret = [];
    return {
        asked, askedSecret,
        ask: async text => { asked.push(text); return answers.length > 0 ? answers.shift() : ''; },
        askSecret: async text => { askedSecret.push(text); return secrets.length > 0 ? secrets.shift() : ''; },
        close: jest.fn()
    };
}

const baseDeps = (prompter, over = {}) => ({
    isTTY: true,
    prompter,
    log: line => logs.push(line),
    configPath,
    defaultWorkpath: path.join(root, '.manyoyo', 'work'),
    validateHostPath: () => {},
    afterSave: jest.fn(async () => {}),
    commandName: 'manyoyo',
    ...over
});
const readConfig = () => JSON5.parse(fs.readFileSync(configPath, 'utf-8'));

describe('manyoyo setup (command line wizard)', () => {
    test('writes agent, work dir and password in one atomic 0600 write; never prints secrets; then runs afterSave', async () => {
        const prompter = scripted({
            // Agent=1(claude)、凭据种类=1、API 地址=跳过、模型、工作目录=默认、是否配软件源=n
            answers: ['1', '1', '0', 'claude-x', '', 'n'],
            secrets: ['sk-ant-VERYSECRET', 'correct horse', 'correct horse']
        });
        const deps = baseDeps(prompter);
        expect(await runSetupCli(deps)).toBe(0);

        const config = readConfig();
        expect(config.runs.claude.env).toEqual(expect.objectContaining({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-VERYSECRET', ANTHROPIC_MODEL: 'claude-x' }));
        expect(config.runs.claude.hostPath).toBe(path.join(root, '.manyoyo', 'work'));
        expect(config.serverPass).toBe('correct horse');
        expect(config.mirrors).toBeUndefined();
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(config.runs.claude.hostPath).isDirectory()).toBe(true);
        const everything = JSON.stringify([logs, prompter.asked, prompter.askedSecret]);
        expect(everything).not.toContain('VERYSECRET');
        expect(everything).not.toContain('correct horse');
        expect(deps.afterSave).toHaveBeenCalledTimes(1);
        expect(prompter.close).toHaveBeenCalled();
    });

    test('keeps comments and unrelated settings of an existing config', async () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{\n    // 我的注释\n    "containerRuntime": "docker",\n    "runs": { "claude": { "volumes": ["/data:/data"] } }\n}\n');
        const prompter = scripted({ answers: ['1', '1', '0', '', '', 'n'], secrets: ['tok-123456', 'password1', 'password1'] });
        expect(await runSetupCli(baseDeps(prompter))).toBe(0);
        const raw = fs.readFileSync(configPath, 'utf-8');
        expect(raw).toContain('// 我的注释');
        const config = JSON5.parse(raw);
        expect(config.containerRuntime).toBe('docker');
        expect(config.runs.claude.volumes).toEqual(['/data:/data']);
        expect(config.runs.claude.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-123456');
    });

    test('password: rejects weak ones and mismatches, then accepts', async () => {
        const prompter = scripted({
            answers: ['1', '1', '0', '', '', 'n'],
            secrets: ['tok-123456', 'short', 'password-one', 'password-two', 'password-ok1', 'password-ok1']
        });
        expect(await runSetupCli(baseDeps(prompter))).toBe(0);
        expect(logs.join('\n')).toContain('密码至少 8 位');
        expect(logs.join('\n')).toContain('两次输入不一致');
        expect(readConfig().serverPass).toBe('password-ok1');
    });

    test('gives up after three bad passwords without writing anything', async () => {
        const prompter = scripted({ answers: ['1', '1', '0', '', '', 'n'], secrets: ['tok-123456', 'a', 'b', 'c'] });
        expect(await runSetupCli(baseDeps(prompter))).toBe(1);
        expect(fs.existsSync(configPath)).toBe(false);
        expect(logs.join('\n')).toContain('失败次数过多');
    });

    test('mirrors: preset, official default and a custom address are validated and saved', async () => {
        const prompter = scripted({
            // 软件源=y；apt 选第 2 个（清华）；npm 跳过；pip 选自定义（预设 4 个，自定义是第 5 项）并输入地址
            answers: ['1', '1', '0', '', '', 'y', '2', '0', '5', 'https://pypi.example.com/simple'],
            secrets: ['tok-123456', 'password-ok1', 'password-ok1']
        });
        expect(await runSetupCli(baseDeps(prompter))).toBe(0);
        expect(readConfig().mirrors).toEqual({ apt: 'https://mirrors.tuna.tsinghua.edu.cn', npm: '', pip: 'https://pypi.example.com/simple' });
    });

    test('a custom mirror with shell metacharacters is refused and asked again', async () => {
        const prompter = scripted({
            answers: ['1', '1', '0', '', '', 'y', '0', '0', '5', 'https://x.example.com/$(id)', 'https://ok.example.com/simple'],
            secrets: ['tok-123456', 'password-ok1', 'password-ok1']
        });
        expect(await runSetupCli(baseDeps(prompter))).toBe(0);
        expect(readConfig().mirrors).toEqual({ apt: '', npm: '', pip: 'https://ok.example.com/simple' });
    });

    test('non-interactive stdin: no prompts, explains the alternatives, writes nothing', async () => {
        const prompter = scripted({});
        expect(await runSetupCli(baseDeps(prompter, { isTTY: false }))).toBe(1);
        expect(prompter.asked).toEqual([]);
        expect(fs.existsSync(configPath)).toBe(false);
        const out = logs.join('\n');
        expect(out).toContain('交互式终端');
        expect(out).toContain('有图形界面');
    });

    test('empty credential, relative work dir and an unusable work dir all exit without writing', async () => {
        expect(await runSetupCli(baseDeps(scripted({ answers: ['1', '1', '0', '', '', 'n'], secrets: [''] })))).toBe(1);
        expect(await runSetupCli(baseDeps(scripted({ answers: ['1', '1', '0', '', 'relative/dir'], secrets: ['tok-123456'] })))).toBe(1);
        const failing = baseDeps(scripted({ answers: ['1', '1', '0', '', ''], secrets: ['tok-123456'] }), { validateHostPath: () => { throw new Error('不允许挂载根目录或home目录。'); } });
        expect(await runSetupCli(failing)).toBe(1);
        expect(logs.join('\n')).toContain('不允许挂载根目录');
        expect(fs.existsSync(configPath)).toBe(false);
    });

    test('a corrupt existing config is not overwritten', async () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{ this is not json');
        const prompter = scripted({ answers: ['1', '1', '0', '', '', 'n'], secrets: ['tok-123456', 'password-ok1', 'password-ok1'] });
        expect(await runSetupCli(baseDeps(prompter))).toBe(1);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ this is not json');
    });
});

describe('createPrompter', () => {
    function harness(terminal) {
        const input = new PassThrough();
        const chunks = [];
        const output = new Writable({ write(chunk, enc, cb) { chunks.push(chunk.toString()); cb(); } });
        const prompter = createPrompter({ input, output, terminal });
        return { input, prompter, text: () => chunks.join('') };
    }

    test('askSecret does not echo what is typed (terminal mode), while ask does', async () => {
        const h = harness(true);
        const visible = h.prompter.ask('名字: ');
        h.input.write('alice\n');
        expect(await visible).toBe('alice');
        const secret = h.prompter.askSecret('密码: ');
        h.input.write('hunter2-secret\n');
        expect(await secret).toBe('hunter2-secret');
        h.prompter.close();
        expect(h.text()).toContain('alice');
        expect(h.text()).toContain('密码: ');
        expect(h.text()).not.toContain('hunter2-secret');
    });

    test('end of input rejects instead of hanging', async () => {
        const h = harness(false);
        const pending = h.prompter.ask('x: ');
        h.input.end();
        await expect(pending).rejects.toThrow('输入已结束');
        await expect(h.prompter.ask('y: ')).rejects.toThrow('输入已结束');
    });

    test('setup exits cleanly when stdin ends in the middle of the wizard', async () => {
        const h = harness(false);
        const deps = baseDeps(h.prompter);
        const done = runSetupCli(deps);
        h.input.write('1\n');
        h.input.end();
        expect(await done).toBe(1);
        expect(logs.join('\n')).toContain('输入已结束，没有改动任何配置');
        expect(fs.existsSync(configPath)).toBe(false);
    });
});
