'use strict';

// 发布流水线的阶段定义与状态判断。状态完全由“事实”推出（git / GitHub / npm 的真实状态），
// 所以随时中断、重开控制台都能从断点继续；本地只记少量不可推导的内容（预检结果、人工清单）。

const { compareReleaseVersions } = require('./versions');
const { expectedAssetNames } = require('./facts');

const MANUAL_CHECKLIST = [
    { id: 'mac-new-user', title: '新建 macOS 用户，执行一键安装命令；浏览器自动打开并已登录，向导走完能收到 Agent 回复，地址栏没有 /shadcn，登出后跳到 /auth/login 且能重新登录' },
    { id: 'mac-upgrade', title: '已装旧版的 Mac：manyoyo update 升到新版 → manyoyo 能打开 → update --rollback 回到旧版 → 再 update' }
];

// 阶段定义：external=true 表示会推送 / 触发 workflow / 发布，执行前必须明确确认
const STAGES = [
    { id: 'preflight', title: '预检', external: false, description: 'build:web、npm test、docs:check、lint:sh（有 shellcheck 时）' },
    { id: 'version', title: '版本', external: false, description: '更新 package.json 版本（镜像有变化时同步 imageVersion 与文档示例）' },
    { id: 'commit', title: '提交', external: false, description: '选择要提交的文件，生成或手写提交说明' },
    { id: 'merge', title: '合并到 main', external: true, description: '合并当前分支到 main 并推送（文档站随 main 自动部署）' },
    { id: 'image', title: '镜像', external: true, description: '发布镜像（仅 Dockerfile / docker/ 或 imageVersion 有变化时需要）' },
    { id: 'packages', title: '安装包构建', external: true, description: '触发 macOS / Linux 离线包构建并等待（只产出 artifact）' },
    { id: 'release', title: 'Release', external: true, description: '创建 GitHub Release（tag 由此产生，会触发 npm 发布）' },
    { id: 'npm', title: 'npm 发布', external: false, description: '等待 npm-publish 成功并确认 npm 上已可见' },
    { id: 'assets', title: '挂载安装包', external: true, description: '把两个平台的安装包上传到 Release，应正好 9 个资产' },
    { id: 'verify', title: '发版后验证', external: true, description: '在干净 runner 上验证安装、update、卸载与一键脚本' },
    { id: 'manual', title: '真机检查', external: false, description: '必须在真实 Mac 上做的检查，逐项勾选' }
];

function successfulRunFor(runs, sha) {
    return (runs || []).find(run => run.status === 'completed' && run.conclusion === 'success' && run.headSha === sha) || null;
}

function bumpPending(facts) {
    const latest = facts.git.latestTag ? facts.git.latestTag.replace(/^v/, '') : null;
    return !latest || compareReleaseVersions(facts.pkg.version, latest) > 0;
}

/**
 * @returns {Array<{id,title,external,description,state,detail}>}
 *   state: done | todo | blocked | warn；blocked 的 detail 说明先做什么
 */
function computeStages(facts, state = {}) {
    const { git, release, npm, image, runs } = facts;
    const V = facts.pkg.version;
    const result = [];
    const add = (id, stateName, detail, extra = {}) => {
        const def = STAGES.find(item => item.id === id);
        result.push({ ...def, state: stateName, detail, ...extra });
    };
    const ghBlock = !facts.gh.ok ? 'gh 未登录或授权失效：先运行 gh auth login（或设置有效的 GITHUB_TOKEN）' : '';
    const merged = git.mergedIntoOriginMain;
    const mainRun = key => successfulRunFor(runs[key], git.originMainSha);
    const imageNeeded = image.exists === false;
    const packagesDone = Boolean(mainRun('macos') && mainRun('linux'));

    const pre = state.preflight;
    add('preflight', pre && pre.ok && pre.fingerprint === git.fingerprint ? 'done' : 'todo',
        pre && pre.fingerprint === git.fingerprint ? (pre.ok ? '当前代码已通过预检' : '上次预检失败，修复后重跑') : '尚未对当前代码做预检（代码有变化会失效）');

    if (release.exists) add('version', 'todo', `v${V} 已发布；发新版本需要先升版本号（只发文档可跳过）`);
    else if (bumpPending(facts)) add('version', 'done', `v${V} 待发布（最近发布 ${git.latestTag || '无'}）`);
    else add('version', 'todo', `版本号 ${V} 未高于最近发布 ${git.latestTag}，需要升版本`);

    if (git.dirty.length > 0) add('commit', 'todo', `${git.dirty.length} 个文件有未提交改动`);
    else add('commit', 'done', '工作区干净');

    if (!git.hasOrigin) add('merge', 'blocked', '没有 origin 远端');
    else if (merged) add('merge', 'done', '当前提交已在 origin/main');
    else if (git.dirty.length > 0) add('merge', 'blocked', '先提交未提交的改动');
    else add('merge', 'todo', `当前分支 ${git.branch || '(分离)'} 尚未进入 origin/main`);

    if (ghBlock) add('image', 'blocked', ghBlock);
    else if (image.exists === true) add('image', 'done', `镜像 ${facts.pkg.imageVersion} 已存在${git.imageChangedSinceTag ? '（注意：docker/ 有改动，若镜像内容变了需要升 imageVersion）' : ''}`);
    else if (image.exists === null) add('image', 'warn', '无法确认镜像是否存在（网络）；不确定时可重新检查');
    else if (!merged) add('image', 'blocked', `镜像 ${facts.pkg.imageVersion} 不存在；先合并到 main`);
    else add('image', 'todo', `镜像 ${facts.pkg.imageVersion} 尚未发布`);

    if (ghBlock) add('packages', 'blocked', ghBlock);
    else if (packagesDone) add('packages', 'done', `main 的当前提交已有成功的两个平台构建（macOS #${mainRun('macos').databaseId}，Linux #${mainRun('linux').databaseId}）`);
    else if (!merged) add('packages', 'blocked', '先合并到 main（构建必须基于 main 的最新提交）');
    else if (imageNeeded) add('packages', 'blocked', '先发布镜像（安装包里带镜像归档）');
    else add('packages', 'todo', 'main 的当前提交还没有成功的构建');

    if (ghBlock) add('release', 'blocked', ghBlock);
    else if (release.exists) add('release', 'done', `v${V} 已创建`, { url: release.url });
    else if (!merged || imageNeeded || !packagesDone) add('release', 'blocked', '需要先完成：合并到 main、镜像、安装包构建');
    else add('release', 'todo', `将创建 v${V} 并触发 npm 发布`);

    if (npm.version === V) add('npm', 'done', `npm 上已是 ${V}`);
    else if (!release.exists) add('npm', 'blocked', '先创建 Release');
    else add('npm', 'todo', `npm 上是 ${npm.version || '未知'}，等待 ${V}（发布后可能延迟几分钟）`);

    const wanted = expectedAssetNames(V);
    const assetsOk = release.exists && JSON.stringify(release.assets) === JSON.stringify(wanted);
    if (assetsOk) add('assets', 'done', 'Release 里正好 9 个资产');
    else if (!release.exists) add('assets', 'blocked', '先创建 Release');
    else if (!packagesDone) add('assets', 'blocked', '先完成安装包构建');
    else add('assets', 'todo', `Release 当前 ${release.assets.length} 个资产，应为 9 个`);

    // 优先用本控制台记下的运行；没有记录时，取该 Release 创建之后成功的最近一次验证
    const verifyRun = (state.verify && state.verify.tag === facts.tag ? (runs.verify || []).find(run => run.databaseId === state.verify.id) : null)
        || (release.exists ? (runs.verify || []).find(run => run.status === 'completed' && run.conclusion === 'success' && Date.parse(run.createdAt) >= Date.parse(release.createdAt)) : null);
    if (verifyRun && verifyRun.status === 'completed' && verifyRun.conclusion === 'success') add('verify', 'done', `验证通过（run #${verifyRun.databaseId}）`);
    else if (!assetsOk) add('verify', 'blocked', '先让 Release 的 9 个资产就位');
    else add('verify', 'todo', verifyRun ? `上次验证 ${verifyRun.conclusion || verifyRun.status}` : '尚未验证');

    // 清单按版本记录：上一次发布勾选过的不会带到下一次
    const checks = (state.checklists || {})[facts.tag] || {};
    const left = MANUAL_CHECKLIST.filter(item => !checks[item.id]).length;
    add('manual', left === 0 ? 'done' : 'todo', left === 0 ? '真机检查全部完成' : `还有 ${left} 项待勾选`);
    return result;
}

/** 下一个该做的阶段（第一个 todo，且前面没有 blocked 之外的阻断）；全部完成返回 null */
function nextStage(stages) {
    return stages.find(stage => stage.state === 'todo' || stage.state === 'warn') || null;
}

module.exports = { STAGES, MANUAL_CHECKLIST, computeStages, nextStage };
