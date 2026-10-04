'use strict';

const fs = require('fs');
const path = require('path');

const NOTES_TEMPLATE = path.join(__dirname, '..', 'release-notes-template.md');

/** Release 说明草稿：模板 + 自上个 tag 以来的提交标题 */
function buildNotesDraft(facts, templateFile = NOTES_TEMPLATE) {
    let template = '';
    try {
        template = fs.readFileSync(templateFile, 'utf-8');
    } catch (error) {
        template = '## 更新内容\n\n…\n';
    }
    const bullets = facts.git.commitsSinceTag.filter(subject => !/^合并 /.test(subject)).map(subject => `- ${subject}`).join('\n') || '- …';
    return template.replace('…', () => bullets);
}

module.exports = { buildNotesDraft };
