'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const apply = require('../lib/extensions-apply');
const store = require('../lib/extensions-store');

const ID = '0123456789abcdef';

function makeFakeRun(state = {}) {
    const calls = [];
    const run = async (args, opts = {}) => {
        calls.push({ args, opts });
        if (args[0] === 'node' && args[1] === '-e' && args[2] === apply.SKILL_LINK_SCRIPT) {
            const params = JSON.parse(args[3]);
            const out = { skills: { claude: params.items.claude.map(item => item.name), codex: params.items.codex.map(item => item.name) }, conflicts: [], warnings: [] };
            return { code: 0, stdout: JSON.stringify(out), stderr: '' };
        }
        if (args[0] === 'node' && args[1] === '-e' && args[2] === apply.MCP_EXISTS_SCRIPT) {
            return { code: 0, stdout: JSON.stringify(state.exists || { claude: [], codex: [] }), stderr: '' };
        }
        return { code: 0, stdout: '{}', stderr: '' };
    };
    return { run, calls };
}

describe('extensions-apply', () => {
    let home;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-apply-'));
        store.writeSkill(home, 'common', 'shared', '---\nname: shared\n---\n');
        store.writeSkill(home, 'claude', 'only-claude', '---\nname: only-claude\n---\n');
        store.saveMcp(home, { name: 'echo', agents: ['claude', 'codex'], transport: 'stdio', command: 'npx', args: ['-y', 'echo-mcp'], env: [{ key: 'K', value: 'sk-secret-value' }] });
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('挂载模式：链接清单 = common + 对应 Agent；Claude JSON 走 stdin、Codex 只用 $K；state 0600', async () => {
        const { run, calls } = makeFakeRun();
        const result = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: ID, mode: 'mount', workDir: '/work', runInContainer: run });
        expect(result.applied).toBe(true);
        expect(result.conflicts).toEqual([]);

        const linkCall = calls.find(call => call.args[2] === apply.SKILL_LINK_SCRIPT);
        const params = JSON.parse(linkCall.args[3]);
        expect(params.items.claude.map(item => `${item.name}@${item.dir}`)).toEqual(['shared@common/shared', 'only-claude@claude/only-claude']);
        expect(params.items.codex.map(item => `${item.name}@${item.dir}`)).toEqual(['shared@common/shared']);
        expect(params.workDir).toBe('/work');

        const bashCalls = calls.filter(call => call.args[0] === '/bin/bash');
        expect(bashCalls).toHaveLength(2);
        const claude = bashCalls[0];
        expect(claude.args).toEqual(['/bin/bash', '-s']);
        expect(claude.opts.stdin).toContain('claude mcp add-json');
        expect(claude.opts.stdin).toContain('sk-secret-value');
        expect(JSON.stringify(claude.args)).not.toContain('sk-secret-value');
        const codex = bashCalls[1];
        expect(codex.opts.stdin).toContain('--env K="${K}"');
        expect(codex.opts.stdin).not.toContain('sk-secret-value');
        expect(codex.opts.extraEnv).toEqual(['K=sk-secret-value']);

        const stateFile = path.join(home, '.manyoyo', 'extensions', 'state', `${ID}.json`);
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state).toEqual(expect.objectContaining({
            mode: 'mount',
            skills: { claude: ['shared', 'only-claude'], codex: ['shared'] },
            mcp: { claude: ['echo'], codex: ['echo'] }
        }));
        expect(JSON.stringify(state)).not.toContain('sk-secret-value');

        // 幂等：内容没变直接跳过，不重复跑 CLI
        const again = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: ID, mode: 'mount', runInContainer: run });
        expect(again).toEqual(expect.objectContaining({ applied: false, skipped: true }));
        const forced = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: ID, mode: 'mount', runInContainer: run, force: true });
        expect(forced.applied).toBe(true);
    });

    test('同名但不在 state 里的 MCP / 技能冲突：跳过不覆盖；禁用的 MCP 从容器移除', async () => {
        store.saveMcp(home, { name: 'echo', agents: ['claude', 'codex'], transport: 'stdio', command: 'npx', env: [{ key: 'K', value: 'next' }] }, store.listMcp(home)[0].id);
        const { run, calls } = makeFakeRun({ exists: { claude: ['user-added'], codex: ['echo'] } });
        // 先把上一份 state 写成登记了 echo，再禁用 echo：应调用移除脚本
        const first = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: ID, mode: 'mount', runInContainer: run });
        expect(first.applied).toBe(true);
        // codex 的 echo 是用户自己加的（不在 state 里）→ conflict；claude 的 echo 不在 exists 里 → 正常下发
        expect(first.conflicts).toEqual(expect.arrayContaining([{ type: 'mcp', agent: 'codex', name: 'echo' }]));
        const codexScripts = calls.filter(call => call.args[0] === '/bin/bash').map(call => call.opts.stdin).filter(Boolean);
        expect(codexScripts.every(script => !script.includes('codex mcp add'))).toBe(true);

        // 加载 state 后禁用并改写：下一次应移除 claude 的 echo
        const state = JSON.parse(fs.readFileSync(path.join(home, '.manyoyo', 'extensions', 'state', `${ID}.json`), 'utf-8'));
        expect(state.mcp.claude).toEqual(['echo']);
        const detail = store.listMcp(home)[0];
        store.saveMcp(home, { name: 'echo', agents: ['claude'], transport: 'stdio', command: 'npx', enabled: false }, detail.id);
        calls.length = 0;
        await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: ID, mode: 'mount', runInContainer: run, force: true });
        const removeCall = calls.find(call => call.args[0] === 'node' && String(call.args[2]).includes("item.agent === 'claude'"));
        expect(removeCall).toBeTruthy();
        expect(JSON.parse(removeCall.args[3]).items).toEqual([{ agent: 'claude', name: 'echo' }]);
    });

    test('复制模式：调用 copySkill 复制 common / 对应 Agent；失败只记 warning；同名已存在记冲突', async () => {
        const copied = [];
        const { run } = makeFakeRun();
        const runCopy = async (args, opts = {}) => {
            if (args[0] === 'node' && args[2] === apply.SKILL_COPY_PREPARE_SCRIPT) {
                return { code: 0, stdout: JSON.stringify({ base: { claude: '/home/u/.claude/skills', codex: '/home/u/.codex/skills' }, existing: ['claude/only-claude'], conflicts: [] }), stderr: '' };
            }
            return run(args, opts);
        };
        const result = await apply.applyExtensions({
            homeDir: home,
            containerName: 'oldbox',
            containerId: 'fedcba9876543210',
            mode: 'copy',
            runInContainer: runCopy,
            copySkill: async (source, dest) => {
                copied.push([source, dest]);
                if (source.endsWith('shared') && dest.includes('.codex')) throw new Error('boom');
            }
        });
        expect(copied).toEqual(expect.arrayContaining([
            [path.join(home, '.manyoyo', 'extensions', 'skills', 'common', 'shared'), '/home/u/.claude/skills/shared'],
            [path.join(home, '.manyoyo', 'extensions', 'skills', 'common', 'shared'), '/home/u/.codex/skills/shared']
        ]));
        expect(result.conflicts).toEqual(expect.arrayContaining([{ type: 'skill', agent: 'claude', name: 'only-claude' }]));
        expect(result.warnings.some(message => message.includes('boom'))).toBe(true);
    });
});
