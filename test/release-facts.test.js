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
});
