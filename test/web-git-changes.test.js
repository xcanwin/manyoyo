'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gitChanges = require('../lib/web/git-changes');

// 命令在容器里是 bash -lc 执行；这里在本机 bash 里跑同一条命令，对真实 git 仓库验证解析结果
function run(command) {
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
    return result.stdout;
}

function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
}

describe('改动视图的 git 命令', () => {
    let repo;
    let marker;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-git-'));
        marker = path.join(repo, '..', `${path.basename(repo)}-pwned`);
        git(repo, 'init', '-q');
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
        fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
        fs.mkdirSync(path.join(repo, 'sub'));
        fs.writeFileSync(path.join(repo, 'sub', '中文 名.md'), 'a\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-qm', 'init');
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
        fs.rmSync(path.join(repo, 'gone.txt'));
        fs.writeFileSync(path.join(repo, 'sub', '中文 名.md'), 'b\n');
        fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
        fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
        git(repo, 'add', 'staged.txt');
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(marker, { force: true });
    });

    test('列出修改、删除、新增（已暂存）、未跟踪，路径相对仓库根目录；从子目录进入也一样', () => {
        for (const workDir of [repo, path.join(repo, 'sub')]) {
            const changes = gitChanges.parseGitChangesOutput(run(gitChanges.buildGitChangesCommand(workDir)));
            expect(changes.repo).toBe(true);
            expect(changes.root).toBe(fs.realpathSync(repo));
            const byPath = Object.fromEntries(changes.files.map(file => [file.path, file]));
            expect(byPath['a.txt']).toMatchObject({ status: 'modified', added: 2, deleted: 1 });
            expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', added: 0, deleted: 1 });
            expect(byPath['staged.txt']).toMatchObject({ status: 'added', added: 1, deleted: 0 });
            expect(byPath['new.txt']).toMatchObject({ status: 'untracked' });
            expect(byPath['sub/中文 名.md']).toMatchObject({ status: 'modified', added: 1, deleted: 1 });
        }
    });

    test('不是 git 仓库时 repo=false', () => {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-nogit-'));
        try {
            expect(gitChanges.parseGitChangesOutput(run(gitChanges.buildGitChangesCommand(plain)))).toMatchObject({ repo: false, files: [] });
            expect(gitChanges.parseGitChangesOutput(run(gitChanges.buildGitChangesCommand('/no/such/dir')))).toMatchObject({ repo: false });
        } finally {
            fs.rmSync(plain, { recursive: true, force: true });
        }
    });

    test('单个文件的 diff；文件名带引号和空格也能取到', () => {
        fs.writeFileSync(path.join(repo, "it's a.txt"), 'q\n');
        git(repo, 'add', "it's a.txt");
        const diff = gitChanges.parseGitDiffOutput(run(gitChanges.buildGitDiffCommand(repo, 'a.txt')));
        expect(diff.repo).toBe(true);
        expect(diff.diff).toContain('-two');
        expect(diff.diff).toContain('+TWO');
        expect(gitChanges.parseGitDiffOutput(run(gitChanges.buildGitDiffCommand(repo, "it's a.txt"))).diff).toContain('+q');
    });

    test('仓库里配置的外部 diff / textconv / fsmonitor 都不会被执行', () => {
        const evil = `touch ${marker}`;
        git(repo, 'config', 'diff.external', evil);
        git(repo, 'config', 'core.fsmonitor', evil);
        git(repo, 'config', 'diff.evil.textconv', `sh -c '${evil}; cat'`);
        fs.writeFileSync(path.join(repo, '.gitattributes'), 'a.txt diff=evil\n');
        run(gitChanges.buildGitChangesCommand(repo));
        const diff = gitChanges.parseGitDiffOutput(run(gitChanges.buildGitDiffCommand(repo, 'a.txt')));
        expect(diff.diff).toContain('+TWO');
        expect(fs.existsSync(marker)).toBe(false);
    });

    test('diff 超过上限时截断并标记', () => {
        fs.writeFileSync(path.join(repo, 'a.txt'), 'x'.repeat(gitChanges.DIFF_MAX_BYTES + 1000) + '\n');
        const diff = gitChanges.parseGitDiffOutput(run(gitChanges.buildGitDiffCommand(repo, 'a.txt')));
        expect(diff.truncated).toBe(true);
        expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(gitChanges.DIFF_MAX_BYTES);
    });

    test('拒绝 - 开头、含换行或 NUL 的路径', () => {
        expect(gitChanges.isAcceptableDiffPath('a.txt')).toBe(true);
        expect(gitChanges.isAcceptableDiffPath('--output=/tmp/x')).toBe(false);
        expect(gitChanges.isAcceptableDiffPath('a\nb')).toBe(false);
        expect(gitChanges.isAcceptableDiffPath('a\0b')).toBe(false);
        expect(gitChanges.isAcceptableDiffPath('')).toBe(false);
    });
});

describe('会话标题的解析（lib/web/session-meta.js）', () => {
    const sessionMeta = require('../lib/web/session-meta');
    test('custom-title（/rename 写的）优先于 ai-title；都取最后一条；坏行跳过', () => {
        const lines = [
            'garbage{',
            JSON.stringify({ type: 'ai-title', aiTitle: '自动 1' }),
            JSON.stringify({ type: 'custom-title', customTitle: '我起的' }),
            JSON.stringify({ type: 'ai-title', aiTitle: '自动 2' })
        ].join('\n');
        expect(sessionMeta.parseClaudeTitleOutput(lines)).toBe('我起的');
        expect(sessionMeta.parseClaudeTitleOutput(JSON.stringify({ type: 'ai-title', aiTitle: '自动' }))).toBe('自动');
        expect(sessionMeta.parseClaudeTitleOutput('')).toBe('');
    });
    test('只列 skill 和实测可用的内置命令，排除终端专用', () => {
        const usable = sessionMeta.listUsableSlashCommands({ all: ['context', 'compact', 'my-skill', 'doctor', 'clear'], skills: ['my-skill', 'doctor'], terminal: ['doctor'] });
        expect(usable).toEqual(['context', 'my-skill']);
    });
    test('标题读取命令只接受 UUID 形式的会话 id', () => {
        expect(sessionMeta.buildClaudeTitleReadCommand('0d6c1f6a-1111-4a2b-9c3d-123456789abc')).toContain('custom-title');
        expect(sessionMeta.buildClaudeTitleReadCommand('x; rm -rf /')).toBe('');
    });
});
