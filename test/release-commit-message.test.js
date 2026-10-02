'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ruleCommitMessage, agentCommitMessage } = require('../scripts/release/commit-message');

describe('rule commit message', () => {
    test.each([
        [['docs/guide/a.md', 'README.md'], /^docs: /],
        [['test/a.test.js', 'frontend/src/x.test.ts'], /^test: /],
        [['.github/workflows/a.yml'], /^ci: /],
        [['package.json', 'package-lock.json'], /^chore: /],
        [['lib/a.js', 'docs/a.md'], /^feat: 调整 lib、docs/]
    ])('%j', (files, pattern) => {
        expect(ruleCommitMessage(files)).toMatch(pattern);
    });

    test('empty selection gives an empty message, objects with path are accepted, length stays short', () => {
        expect(ruleCommitMessage([])).toBe('');
        expect(ruleCommitMessage([{ code: 'M', path: 'lib/a.js' }])).toBe('feat: 调整 lib');
        expect(ruleCommitMessage(['a/x.js', 'b/x.js', 'c/x.js', 'd/x.js']).length).toBeLessThanOrEqual(50);
    });
});

describe('agent commit message', () => {
    const fakeSpawn = ({ code = 0, stdout = '', stderr = '', hang = false }) => () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = jest.fn(() => child.emit('close', null));
        if (!hang) setImmediate(() => { child.stdout.emit('data', stdout); child.stderr.emit('data', stderr); child.emit('close', code); });
        return child;
    };
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-agentmsg-')); });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
    const withAuth = () => { fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}'); };

    test('explains when there is no Codex auth file', async () => {
        const result = await agentCommitMessage({ repoRoot: '/r', homeDir: home, spawnImpl: fakeSpawn({}) });
        expect(result.message).toBeNull();
        expect(result.reason).toContain('认证文件');
    });

    test('extracts the last agent message from the Codex JSONL', async () => {
        withAuth();
        const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"feat: 新增发布控制台"}}\n';
        expect(await agentCommitMessage({ repoRoot: '/r', homeDir: home, spawnImpl: fakeSpawn({ stdout }) })).toEqual({ message: 'feat: 新增发布控制台', reason: '' });
    });

    test('reports a failing exit code, an empty answer and a timeout without throwing', async () => {
        withAuth();
        expect((await agentCommitMessage({ repoRoot: '/r', homeDir: home, spawnImpl: fakeSpawn({ code: 2, stderr: 'boom' }) })).reason).toContain('退出码 2');
        expect((await agentCommitMessage({ repoRoot: '/r', homeDir: home, spawnImpl: fakeSpawn({ stdout: '{}' }) })).reason).toContain('未提取');
        expect((await agentCommitMessage({ repoRoot: '/r', homeDir: home, timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }) })).reason).toContain('超时');
    });
});
