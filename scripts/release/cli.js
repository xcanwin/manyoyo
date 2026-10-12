'use strict';

// 发布控制台的命令行驱动：与网页共用同一套阶段、门禁与任务执行器（JobRunner），人用网页，agent 用命令行。
//   --status [--json]             各阶段状态
//   --notes-draft                 输出 Release 说明草稿
//   --run <阶段,阶段…> [--yes]    执行；含对外动作且没有 --yes 时只打印将执行的命令，退出码 2
//   --remote [--version x.y.z] [--watch]   推送 main 并触发 GitHub Actions 流水线，之后可以关电脑（本身就是授权，不需要 --yes）
//   --remote-status [runId]       流水线进度；结束后取回汇总，指出失败阶段的日志路径

const fs = require('fs');
const path = require('path');
const { collectFacts } = require('./facts');
const { STAGES, computeStages, nextStage, isPublished } = require('./stages');
const { ACTIONS, describeCommands } = require('./actions');
const { JobRunner } = require('./jobs');
const { createBaseContext, createJobContext } = require('./context');
const { acquireJobLock } = require('./lock');
const { buildNotes } = require('./notes');
const { startRemote, fetchRemoteRun, downloadRemoteReport, remoteStatusText } = require('./remote');

const ICON = { done: '✓', todo: '○', blocked: '✗', warn: '!' };
const EXIT = { OK: 0, FAILED: 1, NEEDS_YES: 2 };

function createEngine({ repoRoot, dryRun = false, fetchImpl, actions = ACTIONS, acquireLock }) {
    const base = createBaseContext({ repoRoot, dryRun, fetchImpl });
    const collect = () => collectFacts(base);
    const lock = acquireLock === undefined ? () => acquireJobLock(repoRoot, 'cli') : acquireLock;
    const runner = new JobRunner({
        collect,
        makeCtx: (log, signal) => createJobContext(base, log, signal),
        actions,
        describe: describeCommands,
        getState: () => base.state.load(),
        acquireLock: lock,
        logDir: path.join(repoRoot, '.release', 'logs'),
        dryRun
    });
    return { base, collect, runner, acquireLock: lock };
}

function stageList(arg) {
    const ids = String(arg || '').split(',').map(item => item.trim()).filter(Boolean);
    const unknown = ids.filter(id => !STAGES.some(stage => stage.id === id));
    if (ids.length === 0) throw new Error('--run 需要阶段列表，例如 --run merge,packages');
    if (unknown.length > 0) throw new Error(`未知阶段: ${unknown.join(', ')}（可用: ${STAGES.map(stage => stage.id).join(', ')}）`);
    return ids;
}

function summarize(facts, stages) {
    const next = nextStage(stages);
    return {
        version: facts.pkg.version,
        tag: facts.tag,
        latestTag: facts.git.latestTag,
        branch: facts.git.branch,
        published: isPublished(facts),
        stages: stages.map(stage => ({ id: stage.id, title: stage.title, external: stage.external, state: stage.state, detail: stage.detail })),
        next: next ? next.id : null
    };
}

async function printStatus(engine, io, json) {
    await engine.base.readAsync('git', ['fetch', '--quiet', 'origin', '--tags']);
    const facts = await engine.collect();
    const stages = computeStages(facts, engine.base.state.load());
    const summary = summarize(facts, stages);
    if (json) return io.out(JSON.stringify(summary, null, 2));
    io.out(`版本 ${facts.pkg.version}（最近发布 ${facts.git.latestTag || '无'}），分支 ${facts.git.branch || '(分离)'}\n`);
    for (const stage of stages) io.out(`${ICON[stage.state] || '?'} ${stage.title}（${stage.id}）：${stage.detail}`);
    const next = nextStage(stages);
    if (summary.published && !next) io.out(`\n${facts.tag} 已发布 ✓；下一次发布需要先升版本（--run version --version <x.y.z>）`);
    else if (!next) io.out('\n全部完成');
    else io.out(`\n下一步：${next.title}（npm run release -- --run ${next.id}${next.external ? ' --yes' : ''}）`);
    return undefined;
}

function buildParams(args) {
    const params = {};
    if (args.version || args.imageVersion) params.version = { version: args.version, imageVersion: args.imageVersion };
    if (args.files || args.message) params.commit = { files: String(args.files || '').split(',').map(item => item.trim()).filter(Boolean), message: args.message };
    if (args.notesFile) params.release = { notes: fs.readFileSync(args.notesFile, 'utf-8') };
    if (args.npmDispatch) params.npm = { dispatch: true };
    return params;
}

/** @returns {Promise<number>} 退出码 */
async function runStages(engine, args, io) {
    const stages = stageList(args.run);
    const params = buildParams(args);
    await engine.base.readAsync('git', ['fetch', '--quiet', 'origin', '--tags']);
    const facts = await engine.collect();
    const external = stages.filter(id => STAGES.find(stage => stage.id === id).external);
    if (external.length > 0 && !args.yes && !engine.base.dryRun) {
        io.err('这些阶段会执行对外动作，需要显式授权（加 --yes）。将执行的命令：');
        for (const id of external) {
            io.err(`\n[${id}]`);
            describeCommands(id, facts, params[id] || {}).forEach(line => io.err(`  ${line}`));
        }
        return EXIT.NEEDS_YES;
    }
    const log = args.json ? io.err : io.out;
    const done = new Promise(resolve => {
        const onEvent = event => {
            if (event.type === 'log') log(`[${event.stage}] ${event.line}`);
            else if (event.type === 'stage') log(`[${event.stage}] ${event.state}${event.result ? ` → ${event.result}` : ''}${event.detail ? `：${event.detail}` : ''}`);
            else if (event.type === 'done') {
                engine.runner.off('event', onEvent);
                resolve(event);
            }
        };
        engine.runner.on('event', onEvent);
    });
    // 只指定一个阶段时按“单步”执行：即使状态已是 done 也照做（例如已发布后用 version 升下一个版本）；多个阶段按顺序执行并跳过已完成的
    engine.runner.start({ stages, mode: stages.length === 1 ? 'single' : 'auto', params, confirmed: true });
    const onSigint = () => engine.runner.cancel();
    process.once('SIGINT', onSigint);
    const result = await done;
    process.removeListener('SIGINT', onSigint);
    // 单步模式不检查“执行完是否真的 done”；这里补上
    let unfinished = '';
    if (result.status === 'succeeded' && !engine.base.dryRun) {
        const after = await engine.collect();
        const left = computeStages(after, engine.base.state.load()).filter(stage => stages.includes(stage.id) && stage.state !== 'done');
        unfinished = left.map(stage => `「${stage.title}」${stage.state}：${stage.detail}`).join('；');
    }
    if (args.json) {
        const after = await engine.collect();
        io.out(JSON.stringify({ status: result.status, error: result.error || (unfinished ? `未完成：${unfinished}` : ''), ...summarize(after, computeStages(after, engine.base.state.load())) }, null, 2));
    } else if (result.status !== 'succeeded') io.err(`\n失败：${result.error || result.status}`);
    else if (unfinished) io.err(`\n未完成：${unfinished}`);
    return result.status === 'succeeded' && !unfinished ? EXIT.OK : EXIT.FAILED;
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const WATCH_INTERVAL_MS = 15000;
const WATCH_MAX_MISSES = 5;

/**
 * --remote：升版本（需要时）→ 推送 main → 触发流水线。加了这个参数本身就是授权，不需要 --yes。
 * 不带 --watch 时打印运行地址后立刻返回；带 --watch 时跟到流水线结束，退出码反映结果。
 */
async function runRemote(engine, args, io, deps = {}) {
    const start = deps.start || startRemote;
    const fetchRun = deps.fetch || fetchRemoteRun;
    const download = deps.download || downloadRemoteReport;
    const sleep = deps.sleep || sleepMs;
    let release = null;
    let info;
    try {
        if (engine.acquireLock) release = engine.acquireLock();
        await engine.base.readAsync('git', ['fetch', '--quiet', 'origin', '--tags']);
        const facts = await engine.collect();
        const ctx = { ...createJobContext(engine.base, line => io.out(line), undefined), collect: engine.collect };
        info = await start(ctx, facts, args.version ? { version: args.version } : {});
    } catch (error) {
        io.err(`失败：${error.message}`);
        return EXIT.FAILED;
    } finally {
        if (release) release();
    }
    io.out(`\n发布 ${info.version}（提交 ${String(info.sha).slice(0, 7)}）已交给 GitHub Actions：${info.url || '(dry-run)'}`);
    if (!args.watch || engine.base.dryRun) {
        io.out('可以关电脑了。查看进度和结果：npm run release -- --remote-status');
        return EXIT.OK;
    }
    let last = '';
    let misses = 0;
    for (;;) {
        const run = await fetchRun({ ...engine.base, readAsync: engine.base.readAsync }, String(info.runId));
        misses = run ? 0 : misses + 1;
        // 连续读不到（gh 登出、网络断了）就停下来说明，不要无声地一直循环
        if (misses >= WATCH_MAX_MISSES) {
            io.err(`读不到流水线 #${info.runId} 的状态（连续 ${WATCH_MAX_MISSES} 次）：检查 gh auth status 与网络；流水线本身不受影响，稍后用 --remote-status 查看`);
            return EXIT.FAILED;
        }
        if (run) {
            const text = run.stages.map(stage => `${stage.id}:${stage.result}`).join(' ');
            if (text !== last) {
                io.out(`[${run.status}] ${text}`);
                last = text;
            }
            if (run.status === 'completed') return finishRemote(engine, run, io, download);
        }
        await sleep(WATCH_INTERVAL_MS);
    }
}

async function finishRemote(engine, run, io, download) {
    let report = {};
    if (run.conclusion !== 'success') report = await download(createJobContext(engine.base, line => io.out(line), undefined), run);
    io.out(`\n${remoteStatusText(run, report)}`);
    return run.conclusion === 'success' ? EXIT.OK : EXIT.FAILED;
}

/** --remote-status [runId]：最近一次（或指定的一次）流水线的进度；结束且没成功就取回汇总，指出失败阶段的日志在哪 */
async function runRemoteStatus(engine, args, io, deps = {}) {
    const fetchRun = deps.fetch || fetchRemoteRun;
    const download = deps.download || downloadRemoteReport;
    const run = await fetchRun(engine.base, args.remoteRunId || '');
    if (!run) {
        io.err('没有找到发布流水线的运行（先 npm run release -- --remote）');
        return EXIT.FAILED;
    }
    if (run.status !== 'completed') {
        io.out(remoteStatusText(run));
        return EXIT.OK;
    }
    return finishRemote(engine, run, io, download);
}

async function printNotesDraft(engine, io) {
    io.out(buildNotes(await engine.collect()));
}

module.exports = { createEngine, printStatus, runStages, runRemote, runRemoteStatus, printNotesDraft, stageList, EXIT };
