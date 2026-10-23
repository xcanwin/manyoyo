'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const snap = require('../lib/web/snapshots');

let root;
let work;
let gitDir;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-snap-'));
    work = path.join(root, 'work');
    gitDir = path.join(root, 'snap.git');
    fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const sh = (script, env = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout;
const take = (label = 'x', dir = work) => snap.parseSnapshotOutput(sh(snap.buildSnapshotCommand(dir, label, gitDir)));
const read = file => fs.readFileSync(path.join(work, file), 'utf8');
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.writeFileSync(path.join(work, file), text); };
const exists = file => fs.existsSync(path.join(work, file));

describe('快照', () => {
    test('拍快照返回 40 位提交号；没有变化也能再拍一次', () => {
        write('a.txt', '1');
        const first = take('first');
        const second = take('second');
        expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(second.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(second.sha).not.toBe(first.sha);
    });

    test('工作目录不存在：不可用，不抛错', () => {
        expect(take('x', path.join(root, 'nope'))).toEqual({ skipped: 'unavailable' });
    });

    test('不碰用户自己的 .git，也不把它收进快照；.gitignore 里的东西不进快照', () => {
        spawnSync('git', ['init', '-q'], { cwd: work });
        write('.gitignore', 'ignored/\n');
        write('keep.txt', 'k');
        write('ignored/big.bin', 'zzz');
        const before = fs.readdirSync(path.join(work, '.git')).sort();
        const s = take();
        expect(sh(`git --git-dir=${gitDir} ls-tree -r --name-only ${s.sha}`).split('\n').filter(Boolean).sort()).toEqual(['.gitignore', 'keep.txt']);
        expect(fs.readdirSync(path.join(work, '.git')).sort()).toEqual(before);
        expect(spawnSync('git', ['log', '--oneline'], { cwd: work }).status).not.toBe(0); // 用户仓库里没有被我们加提交
    });

    test('单次超过 3 秒：放弃，标成目录太大', () => {
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
        fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash\n[ "$1" = add ] && sleep 20\nexec ${realGit} "$@"\n`, { mode: 0o755 });
        write('a.txt', '1');
        const started = Date.now();
        const out = sh(snap.buildSnapshotCommand(work, 'slow', gitDir), { PATH: `${bin}:${process.env.PATH}` });
        expect(snap.parseSnapshotOutput(out)).toEqual({ skipped: 'too-large' });
        expect(Date.now() - started).toBeLessThan(8000);
        expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(false);
    }, 20000);

    test('路径、提交说明里的引号 / 空格 / 命令替换不会被执行', () => {
        const odd = path.join(root, `we ird'dir "x" $(touch pwned) \`touch pwned\``);
        fs.mkdirSync(odd);
        fs.writeFileSync(path.join(odd, 'f.txt'), '1');
        const s = take('label $(touch ' + root + '/pwned2); `x`', odd);
        expect(s.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(fs.existsSync(path.join(root, 'pwned')) || fs.existsSync(path.join(odd, 'pwned')) || fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'pwned2'))).toBe(false);
        expect(sh(`git --git-dir=${gitDir} log -1 --format=%s`).trim()).not.toContain('$(');
    });
});

describe('按轮比较', () => {
    test('改动列表带状态与行数；提交号必须是 40 位小写十六进制', () => {
        write('a.txt', 'one\n');
        write('b.txt', 'bye\n');
        const s1 = take();
        write('a.txt', 'one\ntwo\n');
        fs.rmSync(path.join(work, 'b.txt'));
        write('c.txt', 'new\n');
        const s2 = take();
        const changes = snap.parseRoundChangesOutput(sh(snap.buildRoundChangesCommand(work, s1.sha, s2.sha, gitDir)));
        expect(changes.ok).toBe(true);
        expect(Object.fromEntries(changes.files.map(f => [f.path, f.status]))).toEqual({ 'a.txt': 'modified', 'b.txt': 'deleted', 'c.txt': 'added' });
        expect(changes.files.find(f => f.path === 'a.txt')).toMatchObject({ added: 1, deleted: 0 });
        const diff = snap.parseRoundDiffOutput(sh(snap.buildRoundDiffCommand(work, s1.sha, s2.sha, 'a.txt', gitDir)));
        expect(diff.diff).toContain('+two');
        for (const bad of ['abc', 'HEAD', 'a'.repeat(39), 'A'.repeat(40), `${s1.sha}; rm -rf /`, `${s1.sha} --output=x`, '-p']) {
            expect(() => snap.buildRoundChangesCommand(work, bad, s2.sha, gitDir)).toThrow();
            expect(() => snap.buildRoundDiffCommand(work, s1.sha, bad, 'a.txt', gitDir)).toThrow();
            expect(() => snap.buildRestoreCommand(work, bad, gitDir)).toThrow();
            expect(() => snap.buildRestorePreviewCommand(work, bad, gitDir)).toThrow();
        }
        expect(snap.isSnapId(s1.sha)).toBe(true);
        expect(snap.isSnapId('xyz')).toBe(false);
    });

    test('diff 的文件路径当作字面量，不能夹带参数', () => {
        write('a.txt', '1\n');
        const s1 = take();
        write('a.txt', '2\n');
        const s2 = take();
        const diff = snap.parseRoundDiffOutput(sh(snap.buildRoundDiffCommand(work, s1.sha, s2.sha, '--output=/tmp/should-not-exist', gitDir)));
        expect(diff.diff).toBe('');
        expect(fs.existsSync('/tmp/should-not-exist')).toBe(false);
    });
});

describe('回退文件', () => {
    function scenario() {
        write('a.txt', 'a1');
        write('b.txt', 'b1');
        write('.gitignore', 'ignored.txt\n');
        write('ignored.txt', 'i1');
        const s1 = take('round 2 before');
        write('a.txt', 'a2'); // 改
        fs.rmSync(path.join(work, 'b.txt')); // 删
        write('sub/c.txt', 'c-from-bash'); // 新建（比如 bash 生成的文件）
        write('ignored.txt', 'i2'); // 被忽略的文件
        return s1;
    }

    test('预览：改 / 删 / 恢复的数量和文件', () => {
        const s1 = scenario();
        const preview = snap.parseRestorePreviewOutput(sh(snap.buildRestorePreviewCommand(work, s1.sha, gitDir)));
        expect(preview).toMatchObject({ ok: true, total: 3, modify: 1, delete: 1, restore: 1 });
        expect(Object.fromEntries(preview.files.map(f => [f.path, f.action]))).toEqual({ 'a.txt': 'modify', 'b.txt': 'restore', 'sub/c.txt': 'delete' });
        // 预览不改文件
        expect(read('a.txt')).toBe('a2');
        expect(exists('b.txt')).toBe(false);
    });

    test('预览最多列 20 个，数量是总数', () => {
        write('seed.txt', '0');
        const s1 = take();
        for (let i = 0; i < 25; i += 1) write(`n${i}.txt`, String(i));
        const preview = snap.parseRestorePreviewOutput(sh(snap.buildRestorePreviewCommand(work, s1.sha, gitDir)));
        expect(preview.total).toBe(25);
        expect(preview.files).toHaveLength(20);
    });

    test('恢复：改过的改回去、删掉的恢复、新建的删掉，被忽略的不动；回退本身也能撤销', () => {
        const s1 = scenario();
        const restored = snap.parseRestoreOutput(sh(snap.buildRestoreCommand(work, s1.sha, gitDir)));
        expect(restored.ok).toBe(true);
        expect(read('a.txt')).toBe('a1');
        expect(read('b.txt')).toBe('b1');
        expect(exists('sub/c.txt')).toBe(false);
        expect(read('ignored.txt')).toBe('i2');
        // 用“回退前”快照撤销回退
        const undo = snap.parseRestoreOutput(sh(snap.buildRestoreCommand(work, restored.before, gitDir)));
        expect(undo.ok).toBe(true);
        expect(read('a.txt')).toBe('a2');
        expect(exists('b.txt')).toBe(false);
        expect(read('sub/c.txt')).toBe('c-from-bash');
    });

    test('回退到“什么文件都没有”的快照（第一轮开始前的空目录）：新建的文件全部删掉', () => {
        const empty = take('round 1 before');
        write('index.html', '<h1>hi</h1>');
        write('assets/a.css', 'x');
        take('round 1 after');
        const restored = snap.parseRestoreOutput(sh(snap.buildRestoreCommand(work, empty.sha, gitDir)));
        expect(restored.ok).toBe(true);
        expect(exists('index.html')).toBe(false);
        expect(exists('assets/a.css')).toBe(false);
        // 预览同样可用
        write('again.txt', '1');
        expect(snap.parseRestorePreviewOutput(sh(snap.buildRestorePreviewCommand(work, empty.sha, gitDir)))).toMatchObject({ ok: true, delete: 1 });
    });

    test('目标快照不存在：失败，不动文件', () => {
        write('a.txt', 'a1');
        take();
        write('a.txt', 'a2');
        const result = snap.parseRestoreOutput(sh(snap.buildRestoreCommand(work, 'f'.repeat(40), gitDir)));
        expect(result.ok).toBe(false);
        expect(read('a.txt')).toBe('a2');
    });
});
