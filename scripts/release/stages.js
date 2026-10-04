'use strict';

// 发布流水线的阶段定义与状态判断。状态完全由“事实”推出（git / GitHub / npm 的真实状态），
// 所以随时中断、重开控制台都能从断点继续；本地只记少量不可推导的内容（预检结果、人工清单）。

const { compareReleaseVersions } = require('./versions');
const { checkAssets } = require('./facts');
const { matchDeviceRules } = require('./device-rules');

// 发布后的真机检查（依赖已公开的 Release）。发布前的真机检查见 device-rules.js
const MANUAL_CHECKLIST = [
    { id: 'mac-upgrade', title: '已装旧版的 Mac：manyoyo update 升到新版 → manyoyo 能打开 → update --rollback 回到旧版 → 再 update' }
];

// 阶段定义：external=true 表示会推送 / 触发 workflow / 发布，执行前必须明确确认
// group：相邻且 group 相同的阶段并行执行（verify 与 npm 互不依赖）
const STAGES = [
    { id: 'preflight', title: '预检', external: false, description: 'build:web、npm test、docs:check、lint:sh（有 shellcheck 时）；CI 在同一提交上通过也可替代' },
    { id: 'version', title: '版本', external: false, description: '更新 package.json 版本（镜像有变化时同步 imageVersion 与文档示例）' },
    { id: 'commit', title: '提交', external: false, description: '选择要提交的文件，生成或手写提交说明' },
    { id: 'merge', title: '合并到 main', external: true, description: '合并当前分支到 main 并推送（需要预检或 CI 通过；文档站随 main 自动部署）' },
    { id: 'image', title: '镜像', external: true, description: '发布镜像（仅 docker/ 或 imageVersion 有变化时需要；已有 tag 不会被覆盖）' },
    { id: 'packages', title: '安装包构建', external: true, description: '触发 build-packages 构建四个平台的安装包并等待（只产出 artifact）' },
    { id: 'device', title: '发布前真机', external: false, description: '按改动区域匹配必须在真实 Mac 上做的检查（用 CI 产物安装），逐项勾选' },
    { id: 'release', title: 'Release 草稿', external: true, description: '创建 GitHub Release 草稿并钉在安装包构建的提交上（草稿没有 tag、不会成为 latest）' },
    { id: 'assets', title: '挂载安装包', external: true, description: '把安装包上传到草稿 Release，并核对资产与 SHA256SUMS 完全一致' },
    { id: 'publish', title: '公开发布', external: true, description: '把草稿改为公开（这时才创建 tag、成为 latest，并触发 npm 发布）' },
    { id: 'verify', title: '发版后验证', external: true, group: 'post', description: '在干净 runner 上验证安装、update、卸载与一键脚本' },
    { id: 'npm', title: 'npm 发布', external: true, group: 'post', description: '等待 npm-publish 成功并确认 npm 上已可见（没被触发时可用 --npm-dispatch 手动触发）' },
    { id: 'manual', title: '发布后真机', external: false, description: '必须在真实 Mac 上做的发布后检查，逐项勾选' }
];

function successfulRunFor(runs, sha) {
    return (runs || []).find(run => run.status === 'completed' && run.conclusion === 'success' && run.headSha === sha) || null;
}

function bumpPending(facts) {
    const latest = facts.git.latestTag ? facts.git.latestTag.replace(/^v/, '') : null;
    return !latest || compareReleaseVersions(facts.pkg.version, latest) > 0;
}

/** 本次发布需要的真机检查（命中的区域规则） */
function deviceItems(facts) {
    return matchDeviceRules(facts.git.changedFiles || []);
}

/** 公开的 Release 且资产齐全 = 这个版本已经发布出去了 */
function isPublished(facts) {
    const { release } = facts;
    return release.exists && !release.draft && checkAssets(facts.pkg.version, release.assets, release.sums).ok;
}

/**
 * @returns {Array<{id,title,external,description,state,detail}>}
 *   state: done | todo | blocked | warn；blocked 的 detail 说明先做什么
 */
function computeStages(facts, state = {}) {
    const { git, release, npm, image } = facts;
    const runs = facts.runs || {};
    const V = facts.pkg.version;
    const result = [];
    const add = (id, stateName, detail, extra = {}) => {
        const def = STAGES.find(item => item.id === id);
        result.push({ ...def, state: stateName, detail, ...extra });
    };
    const published = isPublished(facts);
    // npm 的 CDN 节点同步有先后，单次读取会在新旧版本间来回跳；动作里连续几次读到新版本后会记下，之后不再因为一次读到旧版本而翻回未完成
    const npmConfirmed = (state.npmVisible || {}).tag === facts.tag;
    const checks = (state.checklists || {})[facts.tag] || {};
    const manualLeft = MANUAL_CHECKLIST.filter(item => !checks[item.id]).length;
    // 公开的 Release 之前的阶段对这个版本已经是历史：之后 main 再前进（文档提交等）也不会把它们翻回未完成
    const verifyRun = (state.verify && state.verify.tag === facts.tag ? (runs.verify || []).find(run => run.databaseId === state.verify.id) : null)
        || (release.exists && !release.draft ? (runs.verify || []).find(run => run.status === 'completed' && run.conclusion === 'success' && Date.parse(run.createdAt) >= Date.parse(release.createdAt)) : null);
    const verifyOk = Boolean(verifyRun && verifyRun.status === 'completed' && verifyRun.conclusion === 'success');
    if (published) {
        const text = `v${V} 已发布`;
        for (const id of ['preflight', 'commit', 'merge', 'image', 'packages', 'device', 'release', 'assets', 'publish']) add(id, 'done', text, id === 'release' ? { url: release.url } : {});
        add('version', 'done', `${text}；下一次发布需要先升版本`);
        add('verify', verifyOk ? 'done' : 'todo', verifyOk ? `验证通过（run #${verifyRun.databaseId}）` : verifyRun ? `上次验证 ${verifyRun.conclusion || verifyRun.status}` : '尚未验证');
        add('npm', npm.version === V || npmConfirmed ? 'done' : 'todo', npm.version === V || npmConfirmed ? `npm 上已是 ${V}` : `npm 上是 ${npm.version || '未知'}，等待 ${V}（发布后可能延迟几分钟）`);
        add('manual', manualLeft === 0 ? 'done' : 'todo', manualLeft === 0 ? '真机检查全部完成' : `还有 ${manualLeft} 项待勾选`);
        return result.sort((a, b) => STAGES.findIndex(item => item.id === a.id) - STAGES.findIndex(item => item.id === b.id));
    }

    const ghBlock = !facts.gh.ok ? 'gh 未登录或授权失效：先运行 gh auth login（或设置有效的 GITHUB_TOKEN）' : '';
    const merged = git.mergedIntoOriginMain;
    const mainRun = key => successfulRunFor(runs[key], git.originMainSha);
    const imageNeeded = image.exists === false;
    const packagesRun = mainRun('packages');
    const packagesDone = Boolean(packagesRun);

    const pre = state.preflight;
    const preflightOk = Boolean(pre && pre.ok && pre.fingerprint === git.fingerprint);
    const ciRun = git.dirty.length === 0 ? successfulRunFor(runs.ci, git.headSha) : null;
    // 已合并进 main 的提交在合并前就过了预检 / CI；合并提交本身（main 上不跑 ci.yml）不应把它翻回未完成
    add('preflight', preflightOk || merged ? 'done' : ciRun ? 'done' : 'todo',
        merged && !preflightOk && !ciRun ? '已合并进 main（合并前已通过预检 / CI）' : preflightOk ? '当前代码已通过预检' : ciRun ? `CI 在当前提交上已通过（run #${ciRun.databaseId}）` : pre && pre.fingerprint === git.fingerprint ? (pre.ok ? '当前代码已通过预检' : '上次预检失败，修复后重跑') : '尚未对当前代码做预检（代码有变化会失效）');

    // 草稿（或资产不全的公开 Release）存在时，版本就是这次要发的版本：不能再把“升版本”当成下一步，中途升版本会让 tag 与草稿对不上
    if (release.exists) add('version', 'done', `v${V} 的 Release ${release.draft ? '草稿已创建' : '已公开但资产不全'}，版本已定`);
    else if (bumpPending(facts)) add('version', 'done', `v${V} 待发布（最近发布 ${git.latestTag || '无'}）`);
    else add('version', 'todo', `版本号 ${V} 未高于最近发布 ${git.latestTag}，需要升版本`);

    if (git.dirty.length > 0) add('commit', 'todo', `${git.dirty.length} 个文件有未提交改动`);
    else add('commit', 'done', '工作区干净');

    if (!git.hasOrigin) add('merge', 'blocked', '没有 origin 远端');
    else if (merged) add('merge', 'done', '当前提交已在 origin/main');
    else if (git.dirty.length > 0) add('merge', 'blocked', '先提交未提交的改动');
    else if (!preflightOk && !ciRun) add('merge', 'blocked', '先通过预检（或等 CI 在当前提交上通过）：未经测试的代码不能合并');
    else add('merge', 'todo', `当前分支 ${git.branch || '(分离)'} 尚未进入 origin/main`);

    if (ghBlock) add('image', 'blocked', ghBlock);
    else if (git.dockerChangedSinceTag && !git.imageVersionChanged && image.exists === true) add('image', 'blocked', `镜像内容变了（docker/ 自 ${git.latestTag} 以来有改动），但 imageVersion ${facts.pkg.imageVersion} 没变：先升 imageVersion（已有 tag 不会被覆盖）`);
    else if (image.exists === true) add('image', 'done', `镜像 ${facts.pkg.imageVersion} 已存在`);
    else if (image.exists === null) add('image', 'warn', '无法确认镜像是否存在（网络）；不确定时可重新检查');
    else if (!merged) add('image', 'blocked', `镜像 ${facts.pkg.imageVersion} 不存在；先合并到 main`);
    else add('image', 'todo', `镜像 ${facts.pkg.imageVersion} 尚未发布`);

    if (ghBlock) add('packages', 'blocked', ghBlock);
    else if (packagesDone) add('packages', 'done', `main 的当前提交已有成功的安装包构建（run #${packagesRun.databaseId}）`);
    else if (!merged) add('packages', 'blocked', '先合并到 main（构建必须基于 main 的最新提交）');
    else if (imageNeeded) add('packages', 'blocked', '先发布镜像（安装包里带镜像归档）');
    else add('packages', 'todo', 'main 的当前提交还没有成功的构建');

    const items = deviceItems(facts);
    const devices = (state.devices || {})[facts.tag] || {};
    // 勾选只对确认时的 main 提交有效：之后又有新提交、安装包重建，就必须重新在真机上确认
    const approved = item => Boolean(devices[item.id] && devices[item.id].done && devices[item.id].sha === git.originMainSha);
    const deviceLeft = items.filter(item => !approved(item));
    if (items.length === 0) add('device', 'done', '本次改动不涉及真机敏感区域');
    else if (deviceLeft.length === 0) add('device', 'done', `${items.length} 项真机检查已全部确认`);
    else add('device', 'todo', `还有 ${deviceLeft.length} 项真机检查待确认${deviceLeft.some(item => devices[item.id] && devices[item.id].done) ? '（有的确认过，但之后 main 的提交变了，需要对新构建重新确认）' : ''}`, { items: items.map(item => ({ ...item, done: approved(item), by: (devices[item.id] || {}).by || '' })) });
    if (items.length > 0 && result[result.length - 1].state === 'done') result[result.length - 1].items = items.map(item => ({ ...item, done: true, by: (devices[item.id] || {}).by || '' }));

    const deviceOk = deviceLeft.length === 0;
    if (ghBlock) add('release', 'blocked', ghBlock);
    else if (release.exists) add('release', 'done', `v${V} 的${release.draft ? '草稿' : ' Release '}已创建`, { url: release.url });
    else if (!merged || imageNeeded || !packagesDone) add('release', 'blocked', '需要先完成：合并到 main、镜像、安装包构建');
    else if (!deviceOk) add('release', 'blocked', '先完成发布前真机检查');
    else add('release', 'todo', `将创建 v${V} 草稿并钉在 ${packagesRun.headSha.slice(0, 7)}`);

    const assetCheck = checkAssets(V, release.assets, release.sums);
    if (release.exists && assetCheck.ok) add('assets', 'done', `资产齐全（${release.assets.length} 个，与 SHA256SUMS 一致）`);
    else if (!release.exists) add('assets', 'blocked', '先创建 Release 草稿');
    else if (!packagesDone) add('assets', 'blocked', '先完成安装包构建');
    else add('assets', 'todo', release.assets.length === 0 ? '草稿里还没有资产' : `资产不齐：缺 ${assetCheck.missing.join('、') || '无'}；多 ${assetCheck.extra.join('、') || '无'}`);

    add('publish', 'blocked', release.exists ? (assetCheck.ok ? '' : '先让资产齐全') : '先创建 Release 草稿');
    const publishDef = result[result.length - 1];
    if (release.exists && assetCheck.ok) {
        publishDef.state = 'todo';
        publishDef.detail = release.draft ? `将把 v${V} 草稿公开（创建 tag、成为 latest、触发 npm 发布）` : `v${V} 已公开`;
    }

    if (verifyOk && release.exists && !release.draft) add('verify', 'done', `验证通过（run #${verifyRun.databaseId}）`);
    else if (release.draft || !release.exists || !assetCheck.ok) add('verify', 'blocked', '先公开发布');
    else add('verify', 'todo', verifyRun ? `上次验证 ${verifyRun.conclusion || verifyRun.status}` : '尚未验证');

    if (npm.version === V || npmConfirmed) add('npm', 'done', `npm 上已是 ${V}`);
    else if (!release.exists || release.draft) add('npm', 'blocked', '先公开发布');
    else add('npm', 'todo', `npm 上是 ${npm.version || '未知'}，等待 ${V}（发布后可能延迟几分钟）`);

    // 清单按版本记录：上一次发布勾选过的不会带到下一次
    add('manual', manualLeft === 0 ? 'done' : 'todo', manualLeft === 0 ? '真机检查全部完成' : `还有 ${manualLeft} 项待勾选`);
    return result;
}

/** 下一个该做的阶段（第一个 todo，且前面没有 blocked 之外的阻断）；全部完成返回 null */
function nextStage(stages) {
    return stages.find(stage => stage.state === 'todo' || stage.state === 'warn') || null;
}

module.exports = { STAGES, MANUAL_CHECKLIST, computeStages, nextStage, deviceItems, isPublished };
