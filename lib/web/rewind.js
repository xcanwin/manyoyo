'use strict';

// 回退对话（Claude）：web 历史里删掉那一轮及之后的消息之外，还要让 Claude 自己的会话也从那一轮之前接着往下走。
// 做法是下一轮命令追加 `--resume-session-at <uuid>`（隐藏参数，2.1.304 实测可用）：在同一个会话文件里从 uuid 那条消息之后另起分支。
// uuid 从容器里的会话 jsonl 里找：对应那条用户提示词记录，往前沿 parentUuid 走到最近的一条 assistant 记录；
// 走到头都没有 = 这是第一轮，下一轮不带 -r，开新会话。
const { isClaudeSessionId } = require('./session-meta');

const RECORDS_LIMIT = 20000;
const TEXT_LIMIT = 4000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 在容器里跑的 node 脚本（只读）：每条记录只留 uuid / parentUuid / 类型 / 时间，用户提示词再带上文本
const RECORDS_SCRIPT = [
    "const fs=require('fs');",
    "const rl=require('readline').createInterface({input:fs.createReadStream(process.argv[1])});",
    'const out=[];',
    "rl.on('line',l=>{let r;try{r=JSON.parse(l)}catch(e){return}",
    "if(!r||typeof r.uuid!=='string'||!['user','assistant','attachment','system'].includes(r.type))return;",
    "const o={u:r.uuid,p:r.parentUuid||null,t:r.type,ts:r.timestamp||''};",
    "if(r.type==='user'&&!r.isSidechain){const c=r.message&&r.message.content;let x='';",
    "if(typeof c==='string')x=c;",
    "else if(Array.isArray(c)&&!c.some(b=>b&&b.type==='tool_result'))x=c.filter(b=>b&&b.type==='text').map(b=>b.text).join('\\n');",
    `o.x=x.slice(0,${TEXT_LIMIT})}`,
    'out.push(o)});',
    `rl.on('close',()=>process.stdout.write(JSON.stringify(out.slice(-${RECORDS_LIMIT}))));`
].join('');

function quote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildClaudeRecordsCommand(sessionId) {
    if (!isClaudeSessionId(sessionId)) return '';
    return [
        `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${sessionId}.jsonl; do`,
        `[ -f "$f" ] && timeout 20 node -e ${quote(RECORDS_SCRIPT)} "$f";`,
        'break; done'
    ].join(' ');
}

function parseClaudeRecords(output) {
    try {
        const list = JSON.parse(String(output || '').trim());
        return Array.isArray(list) ? list.filter(item => item && typeof item.u === 'string') : [];
    } catch (e) {
        return [];
    }
}

/**
 * @returns {{found: boolean, uuid?: string|null}} uuid 为 null 表示回退到第一轮（该清掉引擎会话）
 */
function pickClaudeResumeAt(records, { text, timeMs }) {
    const needle = String(text || '').trim();
    if (!needle) return { found: false };
    const candidates = records.filter(item => item.t === 'user' && typeof item.x === 'string' && item.x.includes(needle));
    if (!candidates.length) return { found: false };
    const distance = item => {
        const at = Date.parse(item.ts);
        return Number.isFinite(at) && Number.isFinite(timeMs) ? Math.abs(at - timeMs) : Number.MAX_SAFE_INTEGER;
    };
    const target = candidates.reduce((best, item) => (distance(item) < distance(best) ? item : best));
    const byId = new Map(records.map(item => [item.u, item]));
    const seen = new Set();
    let current = target.p ? byId.get(target.p) : null;
    while (current && current.t !== 'assistant' && !seen.has(current.u)) {
        seen.add(current.u);
        current = current.p ? byId.get(current.p) : null;
    }
    if (!current || current.t !== 'assistant') return { found: true, uuid: null };
    return UUID_PATTERN.test(current.u) ? { found: true, uuid: current.u } : { found: false };
}

module.exports = { UUID_PATTERN, buildClaudeRecordsCommand, parseClaudeRecords, pickClaudeResumeAt };
