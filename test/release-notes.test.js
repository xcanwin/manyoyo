'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildNotes, buildNotesFromGit, releaseCommits } = require('../scripts/release/notes');

const facts = commits => ({ git: { commitsSinceTag: commits } });

describe('release notes', () => {
    test('Chinese changes list plus one fixed English sentence; nothing for a person to fill in', () => {
        const notes = buildNotes(facts(['feat: 新增 A', 'fix: 修 B']));
        expect(notes).toContain('## 更新内容\n\n- feat: 新增 A\n- fix: 修 B\n');
        expect(notes).toContain('curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh');
        expect(notes).not.toContain('…');
        expect(notes).not.toContain("What's changed");
        // 英文部分只有一句固定的话
        const english = notes.split('\n---\n')[1].trim();
        expect(english.split('\n').filter(Boolean)).toHaveLength(1);
        expect(english).toContain('Chinese notes above');
    });

    test('merge commits, docs: commits and version bumps are not listed; an empty list still reads fine', () => {
        const list = releaseCommits(facts(['合并 feat/x：8.7.0', 'Merge branch main', 'docs: 更新 docs 文档', 'docs(zh): 改写', '升级版本到 8.7.0', 'fix: 真正的修复']));
        expect(list).toEqual(['fix: 真正的修复']);
        expect(buildNotes(facts(['docs: 只改文档']))).toContain('- 内部调整与文档更新');
    });

    test('a commit title with $ replacement patterns cannot corrupt the notes', () => {
        expect(buildNotes(facts(["fix: 处理 $' 与 $& 展开"]))).toContain("- fix: 处理 $' 与 $& 展开");
    });

    test('buildNotesFromGit reads the commits since the latest v* tag (the pipeline has no console)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-notes-'));
        try {
            const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf-8' });
            git('init', '-q', '-b', 'main');
            git('commit', '-q', '--allow-empty', '-m', 'feat: 旧的');
            git('tag', 'v1.0.0');
            git('commit', '-q', '--allow-empty', '-m', 'fix: 新的');
            git('commit', '-q', '--allow-empty', '-m', 'docs: 文档');
            const notes = buildNotesFromGit(dir);
            expect(notes).toContain('- fix: 新的');
            expect(notes).not.toContain('旧的');
            expect(notes).not.toContain('docs: 文档');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
