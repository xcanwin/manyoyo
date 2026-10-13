'use strict';

// 远端发布：把“推送 main + 触发 release-pipeline.yml”做成一个动作，之后全程在 GitHub Actions 里跑（可以关电脑）。
// 命令行 `--remote` 与网页“一键发布”共用这里。外部世界（命令、等待、时间）全部来自注入的 ctx（见 actions.js）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ReleaseError, validateVersion, waitForNewRun } = require('./actions');
const { compareReleaseVersions, buildVersionSuggestions } = require('./versions');
const { buildReport, generateReport } = require('./pipeline-report');

const PIPELINE = 'release-pipeline.yml';

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return fallback;
    }
}

/**
 * 这次要发布什么：版本是否还要升、有没有挡住发布的问题。网页确认框与 startRemote 共用。
 * @returns {{version:string, willBump:boolean, problem:string, code:string}}
 */
function planRemote(facts, requestedVersion = '') {
    const latest = facts.git.latestTag ? facts.git.latestTag.replace(/^v/, '') : null;
    const bumped = !latest || compareReleaseVersions(facts.pkg.version, latest) > 0;
    let version = facts.pkg.version;
    let willBump = false;
    if (requestedVersion) {
        version = requestedVersion;
        willBump = requestedVersion !== facts.pkg.version;
    } else if (!bumped) {
        const recommended = buildVersionSuggestions(latest).find(item => item.recommended);
        version = recommended ? recommended.version : facts.pkg.version;
        willBump = true;
    }
    let problem = '';
    let code = '';
    if (!facts.gh.ok) [problem, code] = ['gh 未登录或授权失效：先运行 gh auth login', 'NO_GH'];
    else if (!facts.git.hasOrigin) [problem, code] = ['没有 origin 远端', 'NO_ORIGIN'];
    else if (facts.git.dirty.length > 0) [problem, code] = [`有 ${facts.git.dirty.length} 个文件未提交：先提交（--run commit …）或还原，再发布`, 'DIRTY'];
    else if (facts.git.branch !== 'main') [problem, code] = [`当前分支是 ${facts.git.branch || '(分离)'}：要在 main 上发布。先合并到 main（--run merge --yes），再运行本命令`, 'NOT_MAIN'];
    return { version, willBump, problem, code };
}

// git push 没配凭据助手时借 gh 的授权（只对这一条命令生效，不改任何 git 配置）
function gitPrefix(ctx, facts) {
    const configured = String(ctx.read('git', ['config', '--get', 'credential.helper']).stdout || '').trim();
    return configured || !facts.gh.ok ? [] : ['-c', 'credential.helper=!gh auth git-credential'];
}

async function runOk(ctx, cmd, args, options = {}) {
    const result = await ctx.run(cmd, args, options);
    if (result.status !== 0) throw new ReleaseError('COMMAND_FAILED', `${cmd} ${args.join(' ')} 失败（退出码 ${result.status}）`);
    return result;
}

/**
 * 升版本（需要时）→ 推送 main → 触发流水线 → 返回运行信息。
 * 在动手之前拒绝所有不满足的前提；--dry-run 下只打印命令。
 * @returns {Promise<{runId:number, url:string, version:string, sha:string}>}
 */
async function startRemote(ctx, facts, params = {}) {
    const requested = String(params.version || '').trim();
    const plan = planRemote(facts, requested);
    if (plan.problem) throw new ReleaseError(plan.code, plan.problem);
    if (requested) validateVersion(requested, facts);
    const prefix = gitPrefix(ctx, facts);

    // 同一组最多排一个等待中的运行，再触发一个会悄悄顶掉排队中的真实发布：已有运行在跑 / 排队就拒绝
    const active = parseJson(String((await ctx.readAsync('gh', ['run', 'list', '--workflow', PIPELINE, '-L', '5', '--json', 'databaseId,status'])).stdout || ''), []);
    const busy = (Array.isArray(active) ? active : []).find(run => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status));
    if (busy) throw new ReleaseError('BUSY', `已有一次发布流水线在进行（#${busy.databaseId}，${busy.status}）：等它结束，或 --remote-status 查看`);

    await runOk(ctx, 'git', [...prefix, 'pull', '--ff-only', 'origin', 'main'], { external: true });
    // pull 可能带来别人已经升好的版本 / 新 tag：按拉取后的状态重新规划，不重复升版本
    const fresh = ctx.collect && !ctx.dryRun ? await ctx.collect() : facts;
    const replan = planRemote(fresh, requested);
    if (replan.problem) throw new ReleaseError(replan.code, replan.problem);
    if (requested) validateVersion(requested, fresh);
    if (replan.willBump) {
        ctx.log(`版本 ${fresh.pkg.version} 还没升：升到 ${replan.version} 并提交`);
        try {
            await runOk(ctx, 'npm', ['version', replan.version, '--no-git-tag-version']);
            await runOk(ctx, 'git', ['add', '--', 'package.json', 'package-lock.json']);
            await runOk(ctx, 'git', ['commit', '-F', '-'], { input: `升级版本到 ${replan.version}\n` });
        } catch (error) {
            // 升了版本却没提交成功：把文件还原，下一次 --remote 才不会被“工作区不干净”挡住
            if (!ctx.dryRun) await ctx.run('git', ['checkout', '--', 'package.json', 'package-lock.json']);
            throw error;
        }
    }
    await runOk(ctx, 'git', [...prefix, 'push', 'origin', 'main'], { external: true });
    const sha = ctx.dryRun ? '<提交>' : String(ctx.read('git', ['rev-parse', 'HEAD']).stdout || '').trim();
    if (!ctx.dryRun && !/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('NO_SHA', '读不到当前提交');

    const since = ctx.now();
    await runOk(ctx, 'gh', ['workflow', 'run', PIPELINE, '--ref', 'main', '-f', `sha=${sha}`], { external: true });
    const run = await waitForNewRun(ctx, PIPELINE, since, ['-b', 'main']);
    let url = '';
    if (!ctx.dryRun) {
        const view = parseJson(String((await ctx.readAsync('gh', ['run', 'view', String(run.databaseId), '--json', 'url'])).stdout || ''), {});
        url = view.url || '';
    }
    ctx.log(`流水线已触发：${url || '(dry-run)'}`);
    return { runId: run.databaseId, url, version: replan.version, sha };
}

/** 流水线一次运行的进度：最近一次（runId 为空）或指定的一次；没有运行返回 null */
async function fetchRemoteRun(ctx, runId) {
    let id = runId;
    if (!id) {
        const list = parseJson(String((await ctx.readAsync('gh', ['run', 'list', '--workflow', PIPELINE, '-L', '1', '--json', 'databaseId'])).stdout || ''), []);
        if (!Array.isArray(list) || list.length === 0) return null;
        id = list[0].databaseId;
    }
    const view = parseJson(String((await ctx.readAsync('gh', ['run', 'view', String(id), '--json', 'databaseId,status,conclusion,url,headSha,jobs'])).stdout || ''), null);
    if (!view) return null;
    const jobs = (view.jobs || []).map(job => ({ id: job.databaseId, name: job.name, status: job.status, conclusion: job.conclusion, started_at: job.startedAt, completed_at: job.completedAt, html_url: job.url }));
    const report = buildReport({ jobs, version: '', sha: view.headSha || '', runUrl: view.url || '' });
    return { runId: view.databaseId, status: view.status, conclusion: view.conclusion || '', url: view.url || '', headSha: view.headSha || '', stages: report.stages };
}

/** 流水线结束后取回汇总 artifact（release-report）到 .release/logs/remote-<id>/，返回目录和失败阶段的日志路径 */
async function downloadRemoteReport(ctx, run) {
    const logDir = path.join(ctx.repoRoot, '.release', 'logs', `remote-${run.runId}`);
    const summaryFile = path.join(logDir, 'release-summary.json');
    const read = () => {
        try {
            return parseJson(fs.readFileSync(summaryFile, 'utf-8'), null);
        } catch (error) {
            return null;
        }
    };
    // 已经取回过就直接用（网页每 10 秒轮询一次，不能每次都删了重下）
    let summary = read();
    if (!summary) {
        fs.rmSync(logDir, { recursive: true, force: true });
        fs.mkdirSync(logDir, { recursive: true });
        const result = await ctx.run('gh', ['run', 'download', String(run.runId), '-n', 'release-report', '-D', logDir], { safe: true });
        if (result.status !== 0) return { logDir, failedLogs: [], summary: null };
        summary = read();
    }
    // 流水线 summary job 在运行还没结束时拉不到 job 日志（失败日志是空的）：没成功的运行，用已结束运行的日志在本地重新生成
    const marker = path.join(logDir, '.regenerated');
    if (run.conclusion && run.conclusion !== 'success' && !fs.existsSync(marker)) {
        try {
            const regenerate = ctx.generateReport || generateReport;
            const repo = process.env.GH_REPO || String(spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: ctx.repoRoot, encoding: 'utf-8' }).stdout || '').trim();
            regenerate({ repo, runId: run.runId, version: (summary && summary.version) || '', sha: run.headSha || '', outDir: logDir });
            summary = read() || summary;
            fs.writeFileSync(marker, '');
        } catch (error) {
            // 重新生成失败就保留 artifact 里的版本（日志可能是空的），不影响其余输出
        }
    }
    const failedLogs = ((summary && summary.stages) || []).filter(stage => stage.logArtifact).map(stage => path.join(logDir, stage.logArtifact));
    return { logDir, failedLogs, summary };
}

const mmss = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const ICON = { success: '✓', failure: '✗', cancelled: '✗', skipped: '-', running: '…' };

function remoteStatusText(run, report = {}) {
    const lines = [`流水线 #${run.runId}：${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}  ${run.url}`];
    for (const stage of run.stages) lines.push(`${ICON[stage.result] || '?'} ${stage.id}  ${stage.result}  ${mmss(stage.durationSec)}`);
    if (run.conclusion && run.conclusion !== 'success' && report.summary === null) lines.push('', `没有取回汇总（运行被取消，或汇总阶段没有跑）：gh run view ${run.runId} --log-failed 看失败 job 的日志`);
    if (report.failedLogs && report.failedLogs.length > 0) lines.push('', `失败阶段的日志在：${report.failedLogs.join('、')}`, `汇总：${path.join(report.logDir, 'release-summary.json')}`);
    return lines.join('\n');
}

module.exports = { PIPELINE, planRemote, startRemote, fetchRemoteRun, downloadRemoteReport, remoteStatusText };
