'use strict';

// Release 说明：中文“更新内容”（提交列表）+ 安装方式 + 一句固定的英文。全自动生成，不需要人编辑。
//   node scripts/release/notes.js [仓库目录]   按“上一个 v* tag 以来的提交”输出说明（流水线里没有发布控制台，直接用它）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NOTES_TEMPLATE = path.join(__dirname, '..', 'release-notes-template.md');
// 不写进说明的提交：合并提交、只改文档、升版本号
const SKIPPED = /^(合并 |Merge |docs(\(.*\))?:|升级版本到 )/;

function releaseCommits(facts) {
    return facts.git.commitsSinceTag.filter(subject => !SKIPPED.test(subject));
}

function buildNotes(facts, templateFile = NOTES_TEMPLATE) {
    const template = fs.readFileSync(templateFile, 'utf-8');
    const bullets = releaseCommits(facts).map(subject => `- ${subject}`).join('\n') || '- 内部调整与文档更新';
    return template.replace('…', () => bullets);
}

function buildNotesFromGit(repoRoot) {
    const git = args => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    const latest = String(git(['tag', '--list', 'v*', '--sort=-v:refname']).stdout || '').split('\n').filter(Boolean)[0];
    const log = latest ? git(['log', '--format=%s', `${latest}..HEAD`]) : git(['log', '--format=%s']);
    return buildNotes({ git: { commitsSinceTag: String(log.stdout || '').split('\n').filter(Boolean) } });
}

if (require.main === module) {
    process.stdout.write(buildNotesFromGit(path.resolve(process.argv[2] || '.')));
}

module.exports = { buildNotes, buildNotesFromGit, releaseCommits };
