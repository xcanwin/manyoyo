'use strict';

// 真机检查的勾选。只能由人确认：网页上点，或在有终端的命令行里输入确认；没有终端一律拒绝（agent 不能代替用户勾选）。

const { DEVICE_RULES } = require('./device-rules');
const { MANUAL_CHECKLIST } = require('./stages');

function checkKind(id) {
    if (DEVICE_RULES.some(rule => rule.id === id)) return 'device';
    if (MANUAL_CHECKLIST.some(item => item.id === id)) return 'manual';
    return null;
}

function allCheckIds() {
    return [...DEVICE_RULES.map(rule => rule.id), ...MANUAL_CHECKLIST.map(item => item.id)];
}

/** 写入勾选；device 类记录谁、在哪个 main 提交（sha）上确认的，manual 类沿用布尔值 */
function recordCheck(state, tag, id, done, by, sha) {
    const kind = checkKind(id);
    if (!kind) throw new Error(`未知的检查项: ${id}`);
    const current = state.load();
    if (kind === 'device') {
        const all = current.devices || {};
        const entry = done ? { done: true, by: by || '', sha: sha || '', at: new Date().toISOString() } : { done: false };
        state.save({ devices: { ...all, [tag]: { ...(all[tag] || {}), [id]: entry } } });
    } else {
        const all = current.checklists || {};
        state.save({ checklists: { ...all, [tag]: { ...(all[tag] || {}), [id]: done === true } } });
    }
}

module.exports = { checkKind, allCheckIds, recordCheck };
