'use strict';

// 本地按阶段的任务日志，给排障用：先看 summary.json，只打开失败阶段的那一份日志。
//   .release/logs/<YYYYMMDD-HHMMSS>-<阶段摘要>/NN-<阶段>.log + summary.json；.release/logs/latest 记录最近一次的目录名；只保留最近 20 次。

const fs = require('fs');
const path = require('path');

const KEEP_RUNS = 20;
const TAIL_LINES = 400;
const RUN_DIR = /^\d{8}-\d{6}-[A-Za-z0-9+._-]*$/;
const STAGE_ID = /^[a-z][a-z-]*$/;

const pad = (value, size = 2) => String(value).padStart(size, '0');

function stamp(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function createJobLog(root, { keep = KEEP_RUNS } = {}) {
    let run = null;

    const save = () => {
        if (!run) return;
        const summary = { startedAt: run.startedAt, finishedAt: run.finishedAt, result: run.result, ...(run.error ? { error: run.error } : {}), stages: run.stages.map(({ startedMs, ...rest }) => rest) };
        fs.writeFileSync(path.join(run.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    };

    const prune = () => {
        const names = fs.readdirSync(root).filter(name => RUN_DIR.test(name)).sort();
        for (const name of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    };

    const begin = event => {
        // 末尾加毫秒：同一秒内启动的两次任务不会共用目录
        const stem = `${stamp(event.at)}-${event.stages.join('+').slice(0, 40)}-${pad(event.at % 1000, 3)}`;
        let name = stem;
        for (let n = 2; fs.existsSync(path.join(root, name)); n += 1) name = `${stem}-${n}`;
        fs.mkdirSync(path.join(root, name), { recursive: true });
        run = {
            name,
            dir: path.join(root, name),
            startedAt: new Date(event.at).toISOString(),
            finishedAt: null,
            result: 'running',
            stages: event.stages.map((id, index) => ({ id, result: 'pending', logFile: `${pad(index + 1)}-${id}.log`, startedAt: null, durationMs: null, detail: '' }))
        };
        save();
        fs.writeFileSync(path.join(root, 'latest'), `${name}\n`);
        prune();
    };

    const stageOf = id => run.stages.find(stage => stage.id === id);

    const apply = event => {
        if (event.type === 'start') return begin(event);
        if (!run) return undefined;
        if (event.type === 'log') {
            const stage = stageOf(event.stage);
            if (stage) fs.appendFileSync(path.join(run.dir, stage.logFile), `${event.line}\n`);
            return undefined;
        }
        if (event.type === 'stage') {
            const stage = stageOf(event.stage);
            if (!stage) return undefined;
            if (event.state === 'running') {
                Object.assign(stage, { result: 'running', startedAt: new Date(event.at).toISOString(), startedMs: event.at });
                fs.appendFileSync(path.join(run.dir, stage.logFile), ''); // 没有输出的阶段也留一个空文件，目录和 summary 对得上
            } else {
                const result = { finished: event.result === 'done' ? 'done' : 'unfinished', skipped: 'skipped', failed: 'failed' }[event.state] || event.state;
                Object.assign(stage, { result, durationMs: stage.startedMs ? event.at - stage.startedMs : 0, detail: event.detail || '' });
            }
        } else if (event.type === 'done') {
            run.finishedAt = new Date(event.at).toISOString();
            run.result = event.status;
            run.error = event.error || '';
            // 并行的兄弟阶段被中断时还停在 running：记成 aborted，别让人以为它还在跑
            for (const stage of run.stages) if (stage.result === 'running') Object.assign(stage, { result: 'aborted', durationMs: event.at - stage.startedMs });
        }
        return save();
    };

    return {
        record(event) {
            try {
                fs.mkdirSync(root, { recursive: true });
                apply(event);
            } catch (error) {
                // 写日志失败不影响发布本身
            }
        }
    };
}

/** 最近一次任务：{ dir, at, summary }；没有返回 null */
function readLatestRun(root) {
    try {
        const dir = fs.readFileSync(path.join(root, 'latest'), 'utf-8').trim();
        if (!RUN_DIR.test(dir)) return null;
        const file = path.join(root, dir, 'summary.json');
        return { dir, at: fs.statSync(file).mtime.toISOString(), summary: JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch (error) {
        return null;
    }
}

/** 某次任务里某个阶段的日志（最后 TAIL_LINES 行）；目录名和阶段 id 都按白名单校验 */
function readStageLog(root, dir, stageId) {
    if (!RUN_DIR.test(String(dir)) || !STAGE_ID.test(String(stageId))) return null;
    try {
        const summary = JSON.parse(fs.readFileSync(path.join(root, dir, 'summary.json'), 'utf-8'));
        const stage = summary.stages.find(item => item.id === stageId);
        if (!stage || !/^\d{2}-[a-z-]+\.log$/.test(stage.logFile)) return null;
        let lines = [];
        try {
            lines = fs.readFileSync(path.join(root, dir, stage.logFile), 'utf-8').split('\n').filter(Boolean);
        } catch (error) {
            // 这个阶段没有输出
        }
        return { lines: lines.slice(-TAIL_LINES), truncated: lines.length > TAIL_LINES };
    } catch (error) {
        return null;
    }
}

module.exports = { createJobLog, readLatestRun, readStageLog, KEEP_RUNS };
