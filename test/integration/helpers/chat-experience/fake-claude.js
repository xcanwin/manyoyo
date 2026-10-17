#!/usr/bin/env node
'use strict';

// 自动体验检查用的假 claude：输出与真实 Claude Code（2.1.x，stream-json + --include-partial-messages）同形的 NDJSON。
// 场景由提示词里**最后一个** `UXS:<场景>:<参数>` 令牌决定（服务端可能把历史注入提示词，只认最后一个）。
// 每条 assistant 文本都先走 message_start + 逐 token 的 content_block_delta，再给整条 assistant——
// 这正是真实 CLI 的形态，也是上一轮假 Agent 漏掉的部分（只在最后一条回复上发增量）。
// 场景的“正确最终回复”写在 /tmp/ux-expected-<令牌>.txt，测试据此核对界面上的回复。
const fs = require('fs');

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
    process.stdout.write('Usage: claude [options]\n  --forward-subagent-text\n  --include-partial-messages\n');
    process.exit(0);
}
const prompt = argv.filter(a => !a.startsWith('--')).pop() || '';
const matches = [...prompt.matchAll(/UXS:([a-z0-9]+):([A-Za-z0-9_.-]*)/g)];
const last = matches[matches.length - 1];
const scenario = last ? last[1] : 'echo';
const param = last ? last[2] : '';
const token = last ? last[0].replace(/[^A-Za-z0-9_-]/g, '_') : 'none';
const stepMs = Number(process.env.UX_STEP_MS || 220);

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const sid = 'ux-fake-session';
let seed = 7;
function rand() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}
const out = obj => new Promise(resolve => {
    if (process.stdout.write(JSON.stringify(obj) + '\n')) resolve();
    else process.stdout.once('drain', resolve);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let msgSeq = 0;
let toolSeq = 0;

// 一条 assistant 文本：先逐 token 增量，再整条
async function say(text, { parent = null, tokenMs = 25 } = {}) {
    const id = `msg_${++msgSeq}`;
    const base = parent ? { parent_tool_use_id: parent } : { parent_tool_use_id: null };
    await out({ type: 'stream_event', ...base, event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } });
    await out({ type: 'stream_event', ...base, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    const pieces = text.match(/[\s\S]{1,6}/g) || [];
    for (const piece of pieces) {
        await out({ type: 'stream_event', ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
        if (tokenMs) await sleep(tokenMs);
    }
    await out({ type: 'stream_event', ...base, event: { type: 'content_block_stop', index: 0 } });
    await out({ type: 'assistant', ...base, message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
}

async function tool(name, input, result, { parent = null, isError = false, waitMs = stepMs } = {}) {
    const id = `toolu_${++toolSeq}`;
    const base = parent ? { parent_tool_use_id: parent } : { parent_tool_use_id: null };
    await out({ type: 'assistant', ...base, message: { id: `msg_${++msgSeq}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    await sleep(waitMs);
    await out({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
    return id;
}

function narration(i) {
    const lines = 1 + Math.floor(rand() * 4);
    const parts = [];
    for (let l = 0; l < lines; l++) parts.push(`第 ${i} 步的说明第 ${l + 1} 行：先看看这里的情况，再决定下一步怎么改。`);
    return parts.join('\n');
}

function finalText(label, lines) {
    const rows = [`${label}：全部完成。`];
    for (let i = 1; i <= lines; i++) rows.push(`- 最终结论第 ${i} 条，正文在流式增长。`);
    return rows.join('\n');
}

async function finish(text, extraResults = []) {
    for (const r of extraResults) await out({ type: 'result', subtype: 'success', result: r, session_id: sid });
    await out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
}

function expect(text) {
    try {
        fs.writeFileSync(`/tmp/ux-expected-${token}.txt`, text);
    } catch (e) {
        // 只读环境下跳过，测试会报“找不到期望值”
    }
}

const scenarios = {
    // 多段说明：说明 → 工具 → 说明 → 工具…，每段说明 1~4 行
    async multi() {
        const steps = parseInt(param, 10) || 12;
        for (let i = 1; i <= steps; i++) {
            await say(narration(i));
            await tool('Bash', { command: `ls -la /tmp/dir-${i}`, description: `列出第 ${i} 个目录` }, `total ${i}\n${'file-entry '.repeat(40)}`, { isError: i % 7 === 0 });
        }
        const text = finalText('多段说明场景', 18);
        expect(text);
        await say(text, { tokenMs: 15 });
        await finish(text);
    },
    // 并行子 Agent：一条消息里 3 个 Agent 调用，子事件交错到达，子 Agent 也有 token 增量和说明
    async parallel() {
        await say('我同时派出三个子 agent 分别统计。');
        const ids = ['toolu_pa', 'toolu_pb', 'toolu_pc'];
        const names = ['/etc/apt', '/etc/ssl', '/etc/default'];
        await out({
            type: 'assistant', parent_tool_use_id: null,
            message: { id: `msg_${++msgSeq}`, role: 'assistant', content: ids.map((id, k) => ({ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'general-purpose', description: `统计 ${names[k]}`, prompt: `统计 ${names[k]} 顶层条目数` } })) }
        });
        await out({ type: 'system', subtype: 'task_started' });
        for (let round = 1; round <= 4; round++) {
            for (let k = 0; k < 3; k++) {
                await say(`子 agent ${k + 1} 第 ${round} 轮：查看 ${names[k]}。`, { parent: ids[k], tokenMs: 10 });
                await tool('Bash', { command: `ls -1A ${names[k]} | wc -l`, description: `数 ${names[k]}` }, `${3 + k + round}`, { parent: ids[k], waitMs: 80 });
                await out({ type: 'system', subtype: 'task_progress' });
            }
        }
        for (let k = 0; k < 3; k++) {
            await say(`**${3 + k}**\n\n统计方式：ls -1A ${names[k]} | wc -l`, { parent: ids[k], tokenMs: 5 });
            await out({ type: 'system', subtype: 'task_notification' });
            await out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[k], content: [{ type: 'text', text: `${3 + k}` }] }] } });
        }
        const text = finalText('三个并行子 agent', 10);
        expect(text);
        await say(text, { tokenMs: 15 });
        await finish(text);
    },
    // 后台任务：形态按真实样本（claude 2.1.290）——前台先给中间结论，后台完成后再给最终结论；
    // 结尾有两个 result，第一个是中间结论
    async background() {
        await say('我先同时发出后台子 agent 和前台 Bash 命令。');
        const bg = 'toolu_bg';
        await out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${++msgSeq}`, role: 'assistant', content: [{ type: 'tool_use', id: bg, name: 'Agent', input: { subagent_type: 'general-purpose', description: '后台统计 /usr/share/doc', prompt: '统计', run_in_background: true } }] } });
        await out({ type: 'system', subtype: 'background_tasks_changed' });
        await out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bg, content: 'Async agent launched successfully.' }] } });
        await tool('Bash', { command: 'ls /etc | wc -l', description: '统计 /etc' }, '129');
        await tool('Bash', { command: 'find /usr/share/doc -maxdepth 1 -type d | wc -l', description: '数目录' }, '470', { parent: bg });
        const middle = '**前台结果已出：ls /etc | wc -l = 129**，后台子 agent 还在统计，完成后给出最终结论。';
        await say(middle);
        for (let i = 1; i <= 4; i++) {
            await tool('Bash', { command: `echo ${i}`, description: `后台第 ${i} 步` }, `${i}`, { parent: bg });
        }
        await say('**结果：470**', { parent: bg, tokenMs: 5 });
        await out({ type: 'system', subtype: 'task_notification' });
        await out({ type: 'system', subtype: 'init', session_id: sid });
        const text = finalText('后台子 agent 已完成，最终结论', 6);
        expect(text);
        await say(text, { tokenMs: 15 });
        await finish(text, [middle]);
    },
    // 大输出：工具结果累计超过 <参数> MB（默认 34，超过服务端 32MB 的 stdout 上限），之后才有最终回复
    async big() {
        const mb = parseInt(param, 10) || 34;
        await say('先读几个大文件。');
        const chunk = 'x'.repeat(1024 * 1024);
        for (let i = 1; i <= mb; i++) {
            await tool('Read', { file_path: `/tmp/big-${i}.log`, description: `读第 ${i} 个大文件` }, chunk, { waitMs: 5 });
        }
        await say('大文件都读完了，开始写结论。');
        const text = finalText('大输出场景', 5);
        expect(text);
        await say(text, { tokenMs: 5 });
        await finish(text);
    },
    // 长回复：最终回复超过 16000 字
    async long() {
        await say('开始写一份很长的报告。');
        const rows = ['长回复场景：全部完成。'];
        for (let i = 1; rows.join('\n').length < 20000; i++) rows.push(`第 ${i} 段：这是一段用来撑长度的报告正文，内容不重要，长度重要。`);
        const text = rows.join('\n');
        expect(text);
        await say(text, { tokenMs: 0 });
        await finish(text);
    },
    async echo() {
        await sleep(300);
        const text = `收到：${prompt.replace(/\s+/g, ' ').slice(-40)}`;
        expect(text);
        await say(text, { tokenMs: 5 });
        await finish(text);
    }
};

(async () => {
    await out({ type: 'system', subtype: 'init', session_id: sid });
    await (scenarios[scenario] || scenarios.echo)();
})().catch(e => {
    process.stderr.write(String(e && e.stack || e) + '\n');
    process.exit(1);
});
