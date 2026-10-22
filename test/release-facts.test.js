'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectFacts, parsePorcelain } = require('../scripts/release/facts');

describe('parsePorcelain', () => {
  test('keeps the full path of an unstaged change on the first line (leading space is part of the status code)', () => {
    expect(parsePorcelain(' M .gitignore\n?? scripts/a.js\nR  old.js -> new.js\n')).toEqual([
      { code: 'M', path: '.gitignore' },
      { code: '??', path: 'scripts/a.js' },
      { code: 'R', path: 'new.js' }
    ]);
  });
});

describe('collectFacts', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-facts-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '8.2.0', imageVersion: '2.1.0-common' }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const reader = (overrides = {}) => (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [pattern, result] of Object.entries(overrides)) if (key.startsWith(pattern)) return { status: 0, stderr: '', ...result };
    return { status: 0, stdout: '', stderr: '' };
  };

  test('the first dirty file keeps its real path (regression: trim() used to eat the leading space)', async () => {
    const facts = await collectFacts({ repoRoot: root, read: reader({ 'git status --porcelain': { stdout: ' M .gitignore\n M a.js\n' } }) });
    expect(facts.git.dirty.map(item => item.path)).toEqual(['.gitignore', 'a.js']);
  });

  test('代码指纹只看文件内容：改动提交后（内容不变）指纹不变，预检不会因为“提交”这一步失效', async () => {
    // 提交前：package.json 有未提交改动，工作区内容对应的 tree 是 T1
    const before = await collectFacts({ repoRoot: root, read: reader({
      'git rev-parse HEAD^{tree}': { stdout: 'T0\n' },
      'git rev-parse HEAD': { stdout: 'H0\n' },
      'git status --porcelain': { stdout: ' M package.json\n' },
      'git diff HEAD': { stdout: 'diff --git a/package.json b/package.json\n' },
      'git stash create': { stdout: 'S1\n' },
      'git rev-parse S1^{tree}': { stdout: 'T1\n' }
    }) });
    // 提交后：工作区干净，新的 HEAD 的 tree 就是 T1
    const after = await collectFacts({ repoRoot: root, read: reader({
      'git rev-parse HEAD^{tree}': { stdout: 'T1\n' },
      'git rev-parse HEAD': { stdout: 'H1\n' },
      'git stash create': { stdout: '' }
    }) });
    expect(after.git.fingerprint).toBe(before.git.fingerprint);
    // 内容真的变了，指纹也要变
    const changed = await collectFacts({ repoRoot: root, read: reader({ 'git rev-parse HEAD^{tree}': { stdout: 'T2\n' }, 'git stash create': { stdout: '' } }) });
    expect(changed.git.fingerprint).not.toBe(after.git.fingerprint);
  });

  test('已提交未推送的文件：领先 origin 时按 name-status 列出，没领先时为空', async () => {
    const facts = await collectFacts({ repoRoot: root, read: reader({
      'git branch --show-current': { stdout: 'main\n' },
      'git remote': { stdout: 'origin\n' },
      'git rev-list --count origin/main..HEAD': { stdout: '2\n' },
      'git diff --name-status --no-renames origin/main..HEAD': { stdout: 'M\tlib/a.js\nA\tdocs/b.md\n' }
    }) });
    expect(facts.git.unpushedFiles).toEqual([{ code: 'M', path: 'lib/a.js' }, { code: 'A', path: 'docs/b.md' }]);
    const clean = await collectFacts({ repoRoot: root, read: reader() });
    expect(clean.git.unpushedFiles).toEqual([]);
  });

  test.each([[200, true], [404, false], [401, null], [429, null], [503, null]])('ghcr manifest status %s means image exists = %s', async (status, expected) => {
    const facts = await collectFacts({
      repoRoot: root,
      read: reader(),
      fetchJson: async () => ({ token: 't' }),
      fetchStatus: async () => status
    });
    expect(facts.image.exists).toBe(expected);
  });

  test('a missing ghcr token is "unknown", not "does not exist"', async () => {
    const facts = await collectFacts({ repoRoot: root, read: reader(), fetchJson: async () => ({}), fetchStatus: async () => 401 });
    expect(facts.image.exists).toBeNull();
  });

  test('network probes run through readAsync when provided', async () => {
    const seen = [];
    const facts = await collectFacts({
      repoRoot: root,
      read: reader(),
      readAsync: async (cmd, args) => { seen.push(cmd); return { status: 0, stdout: cmd === 'npm' ? '8.1.0\n' : '[]', stderr: '' }; }
    });
    expect(seen).toEqual(expect.arrayContaining(['gh', 'npm']));
    expect(facts.npm.version).toBe('8.1.0');
  });

  // 代码版预发布的 code-* tag 固定指向根提交；发布控制台算“最近一次正式版”时不能把它们算进去
  test('code-* tags (rolling code builds) are ignored when working out the latest release tag', async () => {
    const { spawnSync } = require('child_process');
    const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf-8' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    for (const tag of ['v8.1.0', 'v8.2.0', 'code-main', 'code-feat--x']) git('tag', tag);
    const read = (cmd, args) => (cmd === 'git' ? git(...args) : { status: 0, stdout: '', stderr: '' });
    const facts = await collectFacts({ repoRoot: root, read, fetchJson: async () => ({}), fetchStatus: async () => 401 });
    expect(facts.git.latestTag).toBe('v8.2.0');
  });
});
