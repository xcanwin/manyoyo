'use strict';

// 发布控制台的命令行驱动：与网页共用同一套阶段、门禁与任务执行器（JobRunner），人用网页，agent 用命令行。
//   --status [--json]             各阶段状态
//   --notes-draft                 输出 Release 说明草稿
//   --run <阶段,阶段…> [--yes]    执行；含对外动作且没有 --yes 时只打印将执行的命令，退出码 2

const fs = require('fs');
const path = require('path');
const { collectFacts } = require('./facts');
const { STAGES, computeStages, nextStage, isPublished } = require('./stages');
const { ACTIONS, describeCommands } = require('./actions');
const { JobRunner } = require('./jobs');
const { createBaseContext, createJobContext } = require('./context');
const { acquireJobLock } = require('./lock');
const { buildNotesDraft } = require('./notes');

const ICON = { done: '✓', todo: '○', blocked: '✗', warn: '!' };
const EXIT = { OK: 0, FAILED: 1, NEEDS_YES: 2 };

function createEngine({ repoRoot, dryRun = false, fetchImpl, actions = ACTIONS, acquireLock }) {
    const base = createBaseContext({ repoRoot, dryRun, fetchImpl });
    const collect = () => collectFacts(base);
    const runner = new JobRunner({
        collect,
        makeCtx: (log, signal) => createJobContext(base, log, signal),
        actions,
        describe: describeCommands,
        getState: () => base.state.load(),
        acquireLock: acquireLock === undefined ? () => acquireJobLock(repoRoot, 'cli') : acquireLock,
        logFile: path.join(repoRoot, '.release', 'last-job.log'),
        dryRun
    });
    return { base, collect, runner };
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
    if (stages.includes('release') && !args.notesFile) throw new Error('--run release 需要 --notes-file <路径>（先 --notes-draft > notes.md 生成并编辑）');
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

async function printNotesDraft(engine, io) {
    io.out(buildNotesDraft(await engine.collect()));
}

module.exports = { createEngine, printStatus, runStages, printNotesDraft, stageList, EXIT };
