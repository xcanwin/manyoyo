'use strict';

// 各阶段的执行逻辑。外部世界（命令、等待、时间）全部来自注入的 ctx，所以可以用假实现完整测试：
//   ctx.repoRoot  仓库根目录
//   ctx.read(cmd, args)   同步读（只读探测）
//   ctx.run(cmd, args, { external, safe })  异步执行并把输出逐行写进 ctx.log；dry-run 下除 safe=true（只读/本地检查）外一律只打印不执行
//   ctx.log(line)  ctx.sleep(ms)  ctx.now()  ctx.signal（AbortSignal，用于取消）
//   ctx.state { load(), save(patch) }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseReleaseVersion, compareReleaseVersions, normalizeCommitMessage } = require('./versions');
const { WORKFLOWS, NPM_PACKAGE, checkAssets, parseSums, treeFingerprint } = require('./facts');
const { deviceItems } = require('./stages');

const POLL_MS = 15000;
const RUN_APPEAR_TIMEOUT_MS = 120000;
const NPM_VISIBLE_TIMEOUT_MS = 15 * 60 * 1000;
const NPM_CONSECUTIVE_OK = 3;
const RUN_MAX_WAIT_MS = 90 * 60 * 1000;

class ReleaseError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return fallback;
    }
}

// gh / npm 的查询用异步读（不阻塞控制台事件循环）；测试里没有 readAsync 时退回同步 read
function slow(ctx) {
    return ctx.readAsync || (async (cmd, args) => ctx.read(cmd, args));
}

function assertNotAborted(ctx) {
    if (ctx.signal && ctx.signal.aborted) throw new ReleaseError('CANCELLED', '已取消');
}

async function runOk(ctx, cmd, args, options = {}) {
    assertNotAborted(ctx);
    const result = await ctx.run(cmd, args, options);
    assertNotAborted(ctx); // 取消时子进程被终止，退出码是 143：按“已取消”处理，不报命令失败
    if (result.status !== 0) throw new ReleaseError('COMMAND_FAILED', `${cmd} ${args.join(' ')} 失败（退出码 ${result.status}）`);
    return result;
}

// git push 没配凭据助手时借 gh 的授权（只对这一条命令生效，不改任何 git 配置）
function gitPrefix(ctx, facts) {
    const configured = String(ctx.read('git', ['config', '--get', 'credential.helper']).stdout || '').trim();
    return configured || !facts.gh.ok ? [] : ['-c', 'credential.helper=!gh auth git-credential'];
}

// ---------------------------------------------------------------------------
// 等待 GitHub Actions
// ---------------------------------------------------------------------------
async function waitForNewRun(ctx, workflow, sinceMs, extra = []) {
    if (ctx.dryRun) return { databaseId: 0, conclusion: 'success', status: 'completed' };
    const deadline = ctx.now() + RUN_APPEAR_TIMEOUT_MS;
    for (;;) {
        assertNotAborted(ctx);
        const list = parseJson(String((await slow(ctx)('gh', ['run', 'list', '--workflow', workflow, '-L', '10', '--json', 'databaseId,createdAt', ...extra])).stdout || ''), []);
        const found = list.filter(run => Date.parse(run.createdAt) >= sinceMs - 5000).sort((a, b) => a.databaseId - b.databaseId)[0];
        if (found) return found;
        if (ctx.now() > deadline) throw new ReleaseError('RUN_NOT_FOUND', `触发 ${workflow} 后 ${RUN_APPEAR_TIMEOUT_MS / 1000} 秒内没有出现新的运行`);
        await ctx.sleep(3000);
    }
}

// stop：多个等待并行时，一个失败后让其余的退出，不再后台轮询
async function waitForCompletion(ctx, id, label, stop = { stopped: false }) {
    if (ctx.dryRun) return { conclusion: 'success' };
    let last = '';
    const deadline = ctx.now() + RUN_MAX_WAIT_MS;
    for (;;) {
        assertNotAborted(ctx);
        if (stop.stopped) throw new ReleaseError('CANCELLED', `${label} 的等待已停止`);
        if (ctx.now() > deadline) throw new ReleaseError('RUN_TIMEOUT', `${label} #${id} 超过 ${RUN_MAX_WAIT_MS / 60000} 分钟仍未结束`);
        const run = parseJson(String((await slow(ctx)('gh', ['run', 'view', String(id), '--json', 'status,conclusion,url'])).stdout || ''), null);
        const text = run ? `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}` : '查询失败';
        if (text !== last) {
            ctx.log(`${label} #${id}: ${text}${run && run.url ? `  ${run.url}` : ''}`);
            last = text;
        }
        if (run && run.status === 'completed') {
            if (run.conclusion !== 'success') throw new ReleaseError('RUN_FAILED', `${label} #${id} 结束为 ${run.conclusion}，详情见 ${run.url || '运行页面'}`);
            return run;
        }
        await ctx.sleep(POLL_MS);
    }
}

async function triggerAndWait(ctx, workflow, inputs, label, extra = []) {
    const since = ctx.now();
    const args = ['workflow', 'run', workflow, '--ref', 'main'];
    for (const [key, value] of Object.entries(inputs || {})) args.push('-f', `${key}=${value}`);
    await runOk(ctx, 'gh', args, { external: true });
    const run = await waitForNewRun(ctx, workflow, since, extra);
    ctx.log(`${label}: 运行 #${run.databaseId} 已开始`);
    await waitForCompletion(ctx, run.databaseId, label);
    return run;
}

// ---------------------------------------------------------------------------
// 版本与文档示例
// ---------------------------------------------------------------------------
const DOC_IMAGE_SUFFIX = '(?=-(?:common|full)\\b)';

function listMarkdown(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.vitepress' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listMarkdown(full, out);
        else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

/** 把 README 与 docs 里的镜像版本示例（x.y.z-common / -full）从旧主版本改成新的，返回改动的文件 */
function syncDocImageVersion(repoRoot, oldBase, newBase) {
    const changed = [];
    const pattern = new RegExp(`\\b${oldBase.replace(/\./g, '\\.')}${DOC_IMAGE_SUFFIX}`, 'g');
    const files = [path.join(repoRoot, 'README.md'), ...listMarkdown(path.join(repoRoot, 'docs'))];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf-8');
        const next = text.replace(pattern, newBase);
        if (next !== text) {
            fs.writeFileSync(file, next);
            changed.push(path.relative(repoRoot, file));
        }
    }
    return changed;
}

function validateVersion(version, facts) {
    if (!parseReleaseVersion(version)) throw new ReleaseError('BAD_VERSION', `版本号格式无效: ${version}`);
    if (compareReleaseVersions(version, facts.pkg.version) < 0) throw new ReleaseError('BAD_VERSION', `目标版本 ${version} 低于当前 ${facts.pkg.version}`);
    const latest = facts.git.latestTag ? facts.git.latestTag.replace(/^v/, '') : null;
    if (latest && compareReleaseVersions(version, latest) <= 0) throw new ReleaseError('BAD_VERSION', `目标版本 ${version} 必须高于最近发布 ${facts.git.latestTag}`);
}

// ---------------------------------------------------------------------------
// 阶段执行
// ---------------------------------------------------------------------------
// main 当前提交上成功的安装包构建：Release 草稿钉在它的提交上，release-offline 用它的 runId
function packagesRunFor(facts) {
    return ((facts.runs || {}).packages || []).find(run => run.status === 'completed' && run.conclusion === 'success' && run.headSha === facts.git.originMainSha) || null;
}

const ACTIONS = {
    async preflight(ctx, params, facts) {
        const steps = [['npm', ['run', 'build:web']], ['npm', ['test']], ['npm', ['run', 'docs:check']]];
        if (ctx.read('sh', ['-c', 'command -v shellcheck']).status === 0) steps.push(['npm', ['run', 'lint:sh']]);
        else ctx.log('本机没有 shellcheck，跳过 lint:sh（CI 与发版前建议装上）');
        let ok = false;
        try {
            for (const [cmd, args] of steps) await runOk(ctx, cmd, args, { safe: true });
            ok = true;
        } finally {
            ctx.state.save({ preflight: { ok, fingerprint: treeFingerprint(ctx.read, ctx.repoRoot), at: new Date(ctx.now()).toISOString() } });
        }
        ctx.log(`预检通过（${facts.pkg.version}）`);
    },

    async version(ctx, params, facts) {
        if (ctx.dryRun) return ctx.log('[dry-run] 跳过：更新版本（会改 package.json 与文档）');
        const version = String(params.version || '').trim();
        validateVersion(version, facts);
        if (version !== facts.pkg.version) await runOk(ctx, 'npm', ['version', version, '--no-git-tag-version']);
        const imageVersion = String(params.imageVersion || '').trim();
        if (imageVersion && imageVersion !== facts.pkg.imageVersion) {
            if (!/^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(imageVersion)) throw new ReleaseError('BAD_VERSION', `镜像版本格式应为 x.y.z-后缀: ${imageVersion}`);
            const file = path.join(ctx.repoRoot, 'package.json');
            const text = fs.readFileSync(file, 'utf-8');
            const next = text.replace(/("imageVersion"\s*:\s*")[^"]*(")/, `$1${imageVersion}$2`);
            if (next === text) throw new ReleaseError('BAD_VERSION', 'package.json 里没有 imageVersion 字段');
            fs.writeFileSync(file, next);
            const changed = syncDocImageVersion(ctx.repoRoot, facts.pkg.imageVersion.split('-')[0], imageVersion.split('-')[0]);
            ctx.log(`imageVersion → ${imageVersion}；同步了 ${changed.length} 个文档里的镜像版本示例`);
        }
        ctx.log(`版本已更新为 ${version}`);
    },

    async commit(ctx, params, facts) {
        if (ctx.dryRun) return ctx.log('[dry-run] 跳过：提交');
        const dirty = new Set(facts.git.dirty.map(item => item.path));
        const files = (params.files || []).filter(Boolean);
        if (files.length === 0) throw new ReleaseError('NO_FILES', '请至少选择一个要提交的文件');
        const unknown = files.filter(file => !dirty.has(file));
        if (unknown.length > 0) throw new ReleaseError('NO_FILES', `这些文件没有未提交改动: ${unknown.join(', ')}`);
        const message = normalizeCommitMessage(params.message).split('\n').filter(line => !/^co-authored-by:/i.test(line.trim())).join('\n').trim();
        if (!message) throw new ReleaseError('NO_MESSAGE', '提交说明不能为空');
        await runOk(ctx, 'git', ['add', '--', ...files]);
        await runOk(ctx, 'git', ['commit', '-F', '-'], { input: `${message}\n` });
    },

    async merge(ctx, params, facts) {
        const prefix = gitPrefix(ctx, facts);
        const branch = facts.git.branch;
        if (!branch) throw new ReleaseError('NO_BRANCH', '当前不在任何分支上');
        if (branch !== 'main') {
            await runOk(ctx, 'git', ['switch', 'main']);
            await runOk(ctx, 'git', [...prefix, 'pull', '--ff-only', 'origin', 'main'], { external: true });
            await runOk(ctx, 'git', ['merge', '--no-ff', branch, '-m', `合并 ${branch}：${facts.pkg.version}`]);
        }
        await runOk(ctx, 'git', [...prefix, 'push', 'origin', 'main'], { external: true });
    },

    async image(ctx) {
        await triggerAndWait(ctx, WORKFLOWS.image, {}, '镜像发布', ['-b', 'main']);
    },

    async packages(ctx) {
        await triggerAndWait(ctx, WORKFLOWS.packages, {}, '安装包构建', ['-b', 'main']);
    },

    // 真机检查只能由人确认：这里只列出清单和下载命令，没确认完的状态由任务执行器报“未完成”
    async device(ctx, params, facts) {
        const items = deviceItems(facts);
        if (items.length === 0) return ctx.log('本次改动不涉及真机敏感区域');
        const run = packagesRunFor(facts);
        for (const item of items) ctx.log(`- [${item.id}] ${item.title}（命中：${item.files.slice(0, 3).join('、')}${item.files.length > 3 ? ' 等' : ''}）`);
        if (run) ctx.log(`下载 CI 产物：gh run download ${run.databaseId} -n manyoyo-${facts.pkg.version}-macos-<arm64|x64>`);
        ctx.log('检查完成后在网页上勾选，或在终端运行 npm run release -- --check <id>（需要有终端）');
    },

    async release(ctx, params, facts) {
        const notes = String(params.notes || '').trim();
        if (!notes) throw new ReleaseError('NO_NOTES', 'Release 说明不能为空');
        const run = packagesRunFor(facts);
        if (!run) throw new ReleaseError('NO_BUILD', 'main 当前提交上没有成功的安装包构建');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-release-')), 'notes.md');
        fs.writeFileSync(file, `${notes}\n`);
        try {
            // 草稿不创建 tag、不会成为 latest；target 钉在安装包构建的提交上，tag（也就是 npm 包）与离线包同源
            await runOk(ctx, 'gh', ['release', 'create', facts.tag, '--draft', '--target', run.headSha, '--title', facts.tag, '--notes-file', file], { external: true });
        } finally {
            fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
    },

    async assets(ctx, params, facts) {
        const run = packagesRunFor(facts);
        if (!run) throw new ReleaseError('NO_BUILD', 'main 当前提交上没有成功的安装包构建');
        await triggerAndWait(ctx, WORKFLOWS.assets, { tag: facts.tag, runId: run.databaseId }, '挂载安装包', ['-b', 'main']);
        if (!ctx.dryRun) {
            const release = parseJson(String((await slow(ctx)('gh', ['release', 'view', facts.tag, '--json', 'assets'])).stdout || ''), { assets: [] });
            const assetNames = release.assets.map(item => item.name).sort();
            const sums = await slow(ctx)('gh', ['release', 'download', facts.tag, '-p', 'SHA256SUMS', '-O', '-']);
            const result = checkAssets(facts.pkg.version, assetNames, sums.status === 0 ? parseSums(sums.stdout) : null);
            if (!result.ok) throw new ReleaseError('ASSETS_MISMATCH', `Release 资产不齐或与 SHA256SUMS 不一致：缺 ${result.missing.join('、') || '无'}；多 ${result.extra.join('、') || '无'}`);
            ctx.log(`资产齐全（${assetNames.length} 个，与 SHA256SUMS 一致）`);
        }
    },

    async publish(ctx, params, facts) {
        await runOk(ctx, 'gh', ['release', 'edit', facts.tag, '--draft=false'], { external: true });
    },

    async npm(ctx, params, facts) {
        const V = facts.pkg.version;
        if (!ctx.dryRun) {
            // 公开 Release 后 npm-publish 由 release: published 自动触发
            const findRun = async () => {
                const list = parseJson(String((await slow(ctx)('gh', ['run', 'list', '--workflow', WORKFLOWS.npm, '-b', facts.tag, '-L', '5', '--json', 'databaseId'])).stdout || ''), []);
                return list.sort((a, b) => b.databaseId - a.databaseId)[0];
            };
            let run = null;
            const deadline = ctx.now() + RUN_APPEAR_TIMEOUT_MS;
            while (!run) {
                assertNotAborted(ctx);
                run = await findRun();
                if (!run) {
                    if (ctx.now() > deadline) break;
                    await ctx.sleep(3000);
                }
            }
            // 显式要求重新触发（--npm-dispatch）时，上一次已经失败的运行不算数：失败的发布需要重跑
            if (run && params.dispatch === true) {
                const state = parseJson(String((await slow(ctx)('gh', ['run', 'view', String(run.databaseId), '--json', 'status,conclusion'])).stdout || ''), null);
                if (state && state.status === 'completed' && state.conclusion !== 'success') {
                    ctx.log(`上一次 npm-publish #${run.databaseId} 结束为 ${state.conclusion}，重新触发`);
                    run = null;
                }
            }
            if (!run) {
                const manual = `gh workflow run ${WORKFLOWS.npm} --ref ${facts.tag} -f tag=${facts.tag}`;
                if (params.dispatch !== true) throw new ReleaseError('RUN_NOT_FOUND', `没有找到 ${facts.tag} 的 npm-publish 运行（release: published 没有触发）。手动触发：${manual}，或加 --npm-dispatch 重跑本阶段`);
                const since = ctx.now();
                await runOk(ctx, 'gh', ['workflow', 'run', WORKFLOWS.npm, '--ref', facts.tag, '-f', `tag=${facts.tag}`], { external: true });
                run = await waitForNewRun(ctx, WORKFLOWS.npm, since, ['-b', facts.tag]);
            }
            await waitForCompletion(ctx, run.databaseId, 'npm 发布');
            const until = ctx.now() + NPM_VISIBLE_TIMEOUT_MS;
            // registry 的 CDN 节点同步有先后，发布后几分钟内 npm view 会在新旧版本间来回跳：连续几次都读到新版本才算数
            let consecutive = 0;
            for (;;) {
                assertNotAborted(ctx);
                const seen = String((await slow(ctx)('npm', ['view', NPM_PACKAGE, 'version', '--prefer-online'])).stdout || '').trim();
                consecutive = seen === V ? consecutive + 1 : 0;
                if (consecutive >= NPM_CONSECUTIVE_OK) break;
                if (seen === V) ctx.log(`npm 上已出现 ${V}（${consecutive}/${NPM_CONSECUTIVE_OK}），再确认一下…`);
                else ctx.log(`npm 上仍是 ${seen || '未知'}，等待 ${V} 可见…`);
                if (ctx.now() > until) throw new ReleaseError('NPM_TIMEOUT', `npm 上 ${NPM_VISIBLE_TIMEOUT_MS / 60000} 分钟内没有出现 ${V}`);
                await ctx.sleep(consecutive > 0 ? 5000 : POLL_MS);
            }
        }
        ctx.log(`npm 上已是 ${V}`);
    },

    async verify(ctx, params, facts) {
        const run = await triggerAndWait(ctx, WORKFLOWS.verify, { tag: facts.tag }, '发版后验证', ['-b', 'main']);
        ctx.state.save({ verify: { tag: facts.tag, id: run.databaseId } });
    }
};

function packagesSha(facts) {
    const run = packagesRunFor(facts);
    return run ? run.headSha : '<安装包构建的提交>';
}

/** 确认弹窗里展示的“将要执行的命令”，与实际执行保持一致（便于人工核对） */
function describeCommands(id, facts, params = {}) {
    const V = facts.pkg.version;
    const branch = facts.git.branch;
    const gh = args => `gh ${args}`;
    const map = {
        merge: branch === 'main'
            ? ['git push origin main']
            : ['git switch main', 'git pull --ff-only origin main', `git merge --no-ff ${branch}`, 'git push origin main'],
        image: [gh(`workflow run ${WORKFLOWS.image} --ref main`)],
        packages: [gh(`workflow run ${WORKFLOWS.packages} --ref main`)],
        release: [gh(`release create ${facts.tag} --draft --target ${packagesSha(facts)} --title ${facts.tag} --notes-file <说明>`), '（草稿：不创建 tag，也不会成为 latest）'],
        assets: [gh(`workflow run ${WORKFLOWS.assets} --ref main -f tag=${facts.tag} -f runId=<main 上成功的安装包构建>`), gh(`release download ${facts.tag} -p SHA256SUMS -O -（核对资产与清单一致）`)],
        publish: [gh(`release edit ${facts.tag} --draft=false`)],
        verify: [gh(`workflow run ${WORKFLOWS.verify} --ref main -f tag=${facts.tag}`)],
        npm: ['等待 npm-publish（release: published 触发）', `（没触发时加 --npm-dispatch：gh workflow run ${WORKFLOWS.npm} --ref ${facts.tag} -f tag=${facts.tag}）`],
        version: [`npm version ${params.version || V} --no-git-tag-version`],
        commit: [`git add -- ${(params.files || []).join(' ') || '<所选文件>'}`, 'git commit -F -'],
        preflight: ['npm run build:web', 'npm test', 'npm run docs:check', 'npm run lint:sh（有 shellcheck 时）']
    };
    return map[id] || [];
}

module.exports = { ACTIONS, ReleaseError, describeCommands, syncDocImageVersion, validateVersion, waitForCompletion, waitForNewRun };
