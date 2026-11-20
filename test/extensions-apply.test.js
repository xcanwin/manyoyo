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
                return {
                    code: 0,
                    stdout: JSON.stringify({
                        base: { claude: '/home/u/.claude/skills', codex: '/home/u/.codex/skills' },
                        copy: [{ agent: 'claude', name: 'shared' }, { agent: 'codex', name: 'shared' }],
                        upToDate: [],
                        conflicts: [{ type: 'skill', agent: 'claude', name: 'only-claude', reason: 'user-replaced' }]
                    }),
                    stderr: ''
                };
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
        expect(result.conflicts).toEqual(expect.arrayContaining([{ type: 'skill', agent: 'claude', name: 'only-claude', reason: 'user-replaced' }]));
        expect(result.warnings.some(message => message.includes('boom'))).toBe(true);
        expect(result.pending).toBe(true);
    });
});

describe('extensions-apply：受管标记与失败重试', () => {
    let home;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-managed-'));
        store.writeSkill(home, 'common', 'demo', '---\nname: demo\n---\ncontent\n');
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    function runPrepare(params) {
        return require('child_process').spawnSync(process.execPath, ['-e', apply.SKILL_COPY_PREPARE_SCRIPT, JSON.stringify(params)], {
            encoding: 'utf-8',
            env: { ...process.env, HOME: home }
        });
    }

    test('准备脚本不删除用户替换的同名目录；只清理标记与旧哈希匹配的受管副本', () => {
        const userDir = path.join(home, '.claude/skills/keepme');
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(path.join(userDir, 'SKILL.md'), '用户自己的内容');
        const staleDir = path.join(home, '.codex/skills/managed');
        fs.mkdirSync(staleDir, { recursive: true });
        fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '旧副本');
        fs.writeFileSync(path.join(staleDir, '.manyoyo-managed'), JSON.stringify({ app: 'manyoyo', version: 1, hash: 'oldhash' }));
        const mismatchedDir = path.join(home, '.claude/skills/mismatch');
        fs.mkdirSync(mismatchedDir, { recursive: true });
        fs.writeFileSync(path.join(mismatchedDir, 'SKILL.md'), '被用户替换过');
        fs.writeFileSync(path.join(mismatchedDir, '.manyoyo-managed'), JSON.stringify({ app: 'manyoyo', version: 1, hash: 'marker-hash' }));

        const result = runPrepare({
            items: { claude: [], codex: [{ name: 'managed', hash: 'newhash' }] },
            previous: {
                claude: [{ name: 'keepme', hash: 'oldhash' }, { name: 'mismatch', hash: 'state-hash' }],
                codex: [{ name: 'managed', hash: 'oldhash' }]
            }
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // 没有标记 → 用户目录，保留并记冲突
        expect(fs.existsSync(path.join(userDir, 'SKILL.md'))).toBe(true);
        expect(parsed.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'claude', name: 'keepme', reason: 'user-replaced' })]));
        // 标记哈希和 state 不一致 → 保留并记冲突
        expect(fs.existsSync(path.join(mismatchedDir, 'SKILL.md'))).toBe(true);
        expect(parsed.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'claude', name: 'mismatch', reason: 'marker-mismatch' })]));
        // 标记与 state 哈希匹配 → 清掉并重新复制
        expect(fs.existsSync(staleDir)).toBe(false);
        expect(parsed.copy).toEqual([{ agent: 'codex', name: 'managed' }]);
    });

    test('挂载脚本失败：产生 warning 且下一次不会 skipped；成功后第二次才 skipped', async () => {
        let skillCode = 1;
        const calls = [];
        const run = async (args, opts = {}) => {
            calls.push(args);
            if (args[0] === 'node' && args[2] === apply.SKILL_LINK_SCRIPT) {
                return skillCode === 0
                    ? { code: 0, stdout: JSON.stringify({ skills: { claude: ['demo'], codex: ['demo'] }, conflicts: [], warnings: [] }), stderr: '' }
                    : { code: 1, stdout: '', stderr: 'boom-skill' };
            }
            if (args[0] === 'node' && args[2] === apply.MCP_EXISTS_SCRIPT) return { code: 0, stdout: JSON.stringify({ claude: [], codex: [] }), stderr: '' };
            return { code: 0, stdout: '{}', stderr: '' };
        };
        const first = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(first.pending).toBe(true);
        expect(first.warnings.join('\n')).toContain('boom-skill');
        expect(apply.readState(home, '0123456789abcdef').pending).toBe(true);
        const second = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(second.skipped).toBeUndefined();
        expect(second.applied).toBe(true);

        skillCode = 0;
        const third = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(third.pending).toBe(false);
        const fourth = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(fourth).toEqual(expect.objectContaining({ applied: false, skipped: true }));
        expect(calls.length).toBeGreaterThan(0);
    });

    test('MCP 下发脚本失败也算 pending，下次重试', async () => {
        let failMcp = true;
        const run = async (args) => {
            if (args[0] === 'node' && args[2] === apply.SKILL_LINK_SCRIPT) return { code: 0, stdout: JSON.stringify({ skills: { claude: [], codex: [] }, conflicts: [], warnings: [] }), stderr: '' };
            if (args[0] === 'node' && args[2] === apply.MCP_EXISTS_SCRIPT) return { code: 0, stdout: JSON.stringify({ claude: [], codex: [] }), stderr: '' };
            if (args[0] === '/bin/bash') return failMcp ? { code: 1, stdout: '', stderr: 'mcp-fail' } : { code: 0, stdout: '', stderr: '' };
            return { code: 0, stdout: '{}', stderr: '' };
        };
        store.saveMcp(home, { name: 'echo', agents: ['claude'], transport: 'stdio', command: 'npx' });
        const first = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: 'fedcba9876543210', mode: 'mount', runInContainer: run });
        expect(first.pending).toBe(true);
        expect(first.warnings.join('\n')).toContain('mcp-fail');
        failMcp = false;
        const second = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: 'fedcba9876543210', mode: 'mount', runInContainer: run });
        expect(second.pending).toBe(false);
        expect(apply.readState(home, 'fedcba9876543210').pending).toBe(false);
    });
});

describe('extensions-apply：超限技能整体跳过', () => {
    let home;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-oversize-'));
        store.writeSkill(home, 'common', 'demo', '---\nname: demo\n---\nok\n');
        store.writeSkill(home, 'common', 'big', '---\nname: big\n---\nok\n');
        fs.writeFileSync(path.join(home, '.manyoyo', 'extensions', 'skills', 'common', 'big', 'assets.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('skillDirHash 不读取超限文件；同步跳过该技能并给 warning，状态不 pending', async () => {
        const bigDir = path.join(home, '.manyoyo', 'extensions', 'skills', 'common', 'big');
        const spy = jest.spyOn(fs, 'readFileSync');
        expect(apply.skillDirHash(bigDir)).toBe('');
        expect(spy.mock.calls.every(call => !String(call[0]).endsWith('assets.bin'))).toBe(true);
        spy.mockRestore();

        const run = async (args) => {
            if (args[0] === 'node' && args[2] === apply.SKILL_LINK_SCRIPT) {
                const params = JSON.parse(args[3]);
                return { code: 0, stdout: JSON.stringify({ skills: { claude: params.items.claude.map(item => item.name), codex: params.items.codex.map(item => item.name) }, conflicts: [], warnings: [] }), stderr: '' };
            }
            if (args[0] === 'node' && args[2] === apply.MCP_EXISTS_SCRIPT) return { code: 0, stdout: JSON.stringify({ claude: [], codex: [] }), stderr: '' };
            return { code: 0, stdout: '{}', stderr: '' };
        };
        const first = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(first.warnings.join('\n')).toContain('common/big');
        expect(first.pending).toBe(false);
        expect(apply.readState(home, '0123456789abcdef').skills.claude).toEqual(['demo']);
        const second = await apply.applyExtensions({ homeDir: home, containerName: 'box', containerId: '0123456789abcdef', mode: 'mount', runInContainer: run });
        expect(second).toEqual(expect.objectContaining({ applied: false, skipped: true }));
    });
});
