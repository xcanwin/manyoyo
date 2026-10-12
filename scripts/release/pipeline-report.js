'use strict';

// 发布流水线（release-pipeline.yml）的汇总：每个阶段的结果、起止与耗时，失败阶段的日志尾部。
// 排障顺序：先看 release-summary.json → 只打开失败阶段的 failed-<阶段>.log → 还要更多上下文再 gh run view --log-failed --job <id>。
//   node scripts/release/pipeline-report.js --run <runId> --repo <owner/repo> --version <x.y.z> --sha <sha> --out <目录>
//   （在流水线的 summary job 里运行，需要 GH_TOKEN）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_TAIL_LINES = 200;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
const SELF = 'summary';

/** 日志文本 → 最后 N 行（去掉 Actions 的时间戳前缀和终端颜色码） */
function tailLog(text, lines = LOG_TAIL_LINES) {
    const cleaned = String(text || '').replace(ANSI, '').split('\n').map(line => line.replace(TIMESTAMP, ''));
    while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
    return cleaned.slice(-lines).join('\n');
}

function stageResult(conclusions) {
    if (conclusions.includes('failure') || conclusions.includes('timed_out')) return 'failure';
    if (conclusions.includes('cancelled')) return 'cancelled';
    if (conclusions.every(item => item === 'skipped')) return 'skipped';
    if (conclusions.some(item => !item)) return 'running';
    return 'success';
}

/**
 * @param {{jobs: object[], version: string, sha: string, runUrl: string}} input  jobs 是 Actions API 的 jobs 数组
 * 复用 workflow 的 job 名形如 “packages / build-macos (…)”，按 “ / ” 前面的调用方 job id 归成一个阶段
 */
function buildReport({ jobs, version, sha, runUrl }) {
    const groups = new Map();
    for (const item of jobs) {
        const id = String(item.name).split(' / ')[0];
        if (id === SELF) continue;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
    }
    const stages = [];
    const failedJobs = [];
    for (const [id, items] of groups) {
        const started = items.map(item => item.started_at).filter(Boolean).sort();
        const finished = items.map(item => item.completed_at).filter(Boolean).sort();
        const startedAt = started[0] || null;
        const completedAt = finished[finished.length - 1] || null;
        const result = stageResult(items.map(item => item.conclusion));
        // 跳过的 job 没有真正运行，API 给的时间戳甚至会出现结束早于开始
        const ran = result !== 'skipped';
        const durationSec = ran && startedAt && completedAt ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)) : 0;
        const failed = items.filter(item => item.conclusion === 'failure' || item.conclusion === 'timed_out');
        failedJobs.push(...failed.map(item => ({ id: item.id, name: item.name, stage: id, url: item.html_url })));
        stages.push({ id, result, startedAt: ran ? startedAt : null, durationSec, url: (failed[0] || items[0]).html_url });
    }
    const results = stages.map(stage => stage.result);
    const result = results.includes('failure') ? 'failure' : results.includes('cancelled') ? 'cancelled' : results.every(item => item === 'skipped') ? 'cancelled' : 'success';
    return { version, sha, runUrl, result, stages, failedJobs };
}

const mmss = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

function renderMarkdown(report) {
    const rows = report.stages.map(stage => `| ${stage.id} | ${stage.result} | ${stage.startedAt || '-'} | ${mmss(stage.durationSec)} | [日志](${stage.url}) |`);
    return [
        `## 发布流水线 ${report.version} → ${report.result}`,
        '',
        `提交 \`${report.sha}\`，[本次运行](${report.runUrl})`,
        '',
        '| 阶段 | 结果 | 开始 | 耗时 | 链接 |',
        '|---|---|---|---|---|',
        ...rows,
        '',
        report.failedJobs.length ? `失败阶段的日志尾部在 artifact \`release-report\` 里：${[...new Set(report.failedJobs.map(item => `failed-${item.stage}.log`))].join('、')}` : '没有失败的阶段。',
        ''
    ].join('\n');
}

/** 写 release-summary.json、summary.md，以及每个失败阶段一份 failed-<阶段>.log */
function writeReport({ report, outDir, fetchLog }) {
    fs.mkdirSync(outDir, { recursive: true });
    const byStage = new Map();
    for (const failed of report.failedJobs) {
        if (!byStage.has(failed.stage)) byStage.set(failed.stage, []);
        byStage.get(failed.stage).push(failed);
    }
    for (const [stage, jobs] of byStage) {
        const text = jobs.map(item => `===== ${item.name} (${item.url}) =====\n${tailLog(fetchLog(item.id))}`).join('\n\n');
        fs.writeFileSync(path.join(outDir, `failed-${stage}.log`), `${text}\n`);
        const entry = report.stages.find(item => item.id === stage);
        if (entry) entry.logArtifact = `failed-${stage}.log`;
    }
    const { failedJobs, ...summary } = report;
    fs.writeFileSync(path.join(outDir, 'release-summary.json'), `${JSON.stringify({ ...summary, failedJobs: failedJobs.map(({ id, name, stage }) => ({ id, name, stage })) }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'summary.md'), renderMarkdown(report));
    return report;
}

function gh(args) {
    const result = spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return { status: result.error ? 127 : result.status, stdout: result.stdout || '' };
}

/** 一次运行的全部 job；读不到就报错（不能把“读不到”当成“没有 job”，否则会产出一份误导人的空报告） */
function loadJobs(ghImpl, repo, run) {
    // --paginate 对每一页各输出一个 JSON 对象：用 --jq 展平成每行一个 job
    const result = ghImpl(['api', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`, '--paginate', '--jq', '.jobs[] | @json']);
    if (result.status !== 0) throw new Error(`读不到运行 ${run} 的 job 列表（gh api 退出码 ${result.status}）`);
    return result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function main(argv) {
    const get = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : ''; };
    const [run, repo, out] = [get('run'), get('repo'), get('out')];
    if (!run || !repo || !out) throw new Error('用法: pipeline-report.js --run <id> --repo <owner/repo> --version <v> --sha <sha> --out <目录>');
    const jobs = loadJobs(gh, repo, run);
    const report = buildReport({ jobs, version: get('version'), sha: get('sha'), runUrl: `https://github.com/${repo}/actions/runs/${run}` });
    writeReport({ report, outDir: out, fetchLog: id => gh(['api', `repos/${repo}/actions/jobs/${id}/logs`]).stdout });
    process.stdout.write(renderMarkdown(report));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { buildReport, tailLog, renderMarkdown, writeReport, loadJobs, LOG_TAIL_LINES };
