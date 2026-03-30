#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');
const {
    parseReleaseVersion,
    compareReleaseVersions,
    buildVersionSuggestions,
    findRecommendedChoiceIndex,
    pickLatestVersionTag,
    normalizeCommitMessage,
    extractAgentMessageFromCodexJsonl
} = require('../lib/dev-release');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMMIT_DIFF_MANYOYO_TIMEOUT_MS = 90000;
const RELEASE_DEBUG = process.env.MANYOYO_RELEASE_DEBUG === '1';

function printSection(title) {
    console.log(`\n=== ${title} ===`);
}

function shortenLine(text, maxLength = 88) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

function shortenBlock(text, maxLength = 2000) {
    const value = String(text || '');
    if (!value) {
        return '';
    }
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

function printHelp() {
    console.log(`manyoyo dev release

维护者发布向导，不属于 manyoyo 面向用户的主 CLI。

用法:
  npm run dev:release
  npm run dev:release -- --version 5.6.2
  node scripts/dev-release.js --version 5.6.2

流程:
  1. 选择目标版本并更新 package.json/package-lock.json
  2. 执行 npm install
  3. 默认通过 manyoyo run 在容器内自动执行 commit-diff，失败时回退到手动粘贴
  4. 确认文案后继续提交、推送当前分支、打 tag、推送 tag

手动回退:
  在当前 Codex 会话中执行 $commit-diff
  再把生成的代码块粘贴回向导

选项:
  --version <x.y.z>  直接指定目标版本
  --help             显示帮助
`);
}

function runRepoCommand(command, args, options = {}) {
    const spawnOptions = {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: options.stdio || 'pipe'
    };
    if (Object.prototype.hasOwnProperty.call(options, 'input')) {
        spawnOptions.input = options.input;
        if (spawnOptions.stdio === 'inherit') {
            spawnOptions.stdio = ['pipe', 'inherit', 'inherit'];
        }
    }
    const result = spawnSync(command, args, {
        ...spawnOptions
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        throw new Error(detail || `${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
    return result.stdout || '';
}

function getNpmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readPackageJson() {
    const packagePath = path.join(REPO_ROOT, 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
}

function ensureVersionSelectable(version, currentVersion, latestTagInfo) {
    const parsed = parseReleaseVersion(version);
    if (!parsed) {
        throw new Error(`版本号格式无效: ${version}`);
    }
    if (compareReleaseVersions(version, currentVersion) < 0) {
        throw new Error(`目标版本 ${version} 低于当前 package.json.version ${currentVersion}`);
    }
    if (latestTagInfo && compareReleaseVersions(version, latestTagInfo.version) < 0) {
        throw new Error(`目标版本 ${version} 低于最新标签 ${latestTagInfo.tag}`);
    }
}

async function ask(question, rl) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(String(answer || '').trim());
        });
    });
}

function createInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

async function askYesNo(question, rl, defaultValue = false) {
    const suffix = defaultValue ? ' [Y/n]: ' : ' [y/N]: ';
    const answer = (await ask(question + suffix, rl)).toLowerCase();
    if (!answer) {
        return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
}

async function askChoice(title, options, rl, defaultIndex = 0) {
    if (title) {
        console.log(`\n${title}`);
    }
    options.forEach((option, index) => {
        const recommended = option.recommended ? ' (推荐)' : '';
        console.log(`  ${index + 1}. ${option.label}${recommended}`);
    });
    while (true) {
        const answer = await ask(`请选择 [默认 ${defaultIndex + 1}]: `, rl);
        const selectedIndex = answer ? Number(answer) - 1 : defaultIndex;
        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < options.length) {
            return options[selectedIndex];
        }
        console.log('输入无效，请重新选择。');
    }
}

function getLatestTagInfo() {
    const tags = runRepoCommand('git', ['tag', '--list']).split(/\r?\n/);
    return pickLatestVersionTag(tags);
}

function getBaseVersion(currentVersion, latestTagInfo) {
    if (!latestTagInfo) {
        return currentVersion;
    }
    return compareReleaseVersions(latestTagInfo.version, currentVersion) > 0
        ? latestTagInfo.version
        : currentVersion;
}

async function chooseTargetVersion(currentVersion, latestTagInfo, rl, directVersion) {
    const baseVersion = getBaseVersion(currentVersion, latestTagInfo);
    const choices = buildVersionSuggestions(baseVersion).map(item => ({
        label: `${item.label}: ${item.version}`,
        value: item.version,
        recommended: item.recommended
    }));

    if (directVersion) {
        ensureVersionSelectable(directVersion, currentVersion, latestTagInfo);
        return directVersion;
    }

    const versionOptions = [
        ...choices,
        { label: '手动输入版本号', value: 'custom', recommended: false }
    ];
    const selection = await askChoice('', versionOptions, rl, findRecommendedChoiceIndex(versionOptions, 0));

    if (selection.value !== 'custom') {
        ensureVersionSelectable(selection.value, currentVersion, latestTagInfo);
        return selection.value;
    }

    while (true) {
        const customVersion = await ask('输入目标版本 (x.y.z): ', rl);
        try {
            ensureVersionSelectable(customVersion, currentVersion, latestTagInfo);
            return customVersion;
        } catch (error) {
            console.log(error.message);
        }
    }
}

function checkExistingTag(version) {
    const output = runRepoCommand('git', ['tag', '--list', `v${version}`]).trim();
    if (output) {
        throw new Error(`标签 v${version} 已存在`);
    }
}

function printState(currentVersion, latestTagInfo, status) {
    printSection('当前状态');
    const branch = runRepoCommand('git', ['branch', '--show-current']).trim() || '(detached HEAD)';
    const latestCommit = runRepoCommand('git', ['show', '-s', '--format=%h %s', 'HEAD']).trim();
    console.log(`当前版本: ${currentVersion}`);
    console.log(`最新标签: ${latestTagInfo ? latestTagInfo.tag : '(无语义化标签)'}`);
    console.log(`当前分支: ${branch}`);
    console.log(`最近提交: ${shortenLine(latestCommit || '(无提交)')}`);
    console.log(`工作区状态: ${status ? '有未提交改动' : '干净'}`);
    if (status) {
        console.log(status);
    }
}

async function maybeRunChecks(rl) {
    printSection('发布前检查');
    const choice = await askChoice('', [
        { label: '只跑 npm audit', value: 'audit', recommended: true },
        { label: '跑 npm audit + npm test + npm run docs:build', value: 'full', recommended: false },
        { label: '跳过检查', value: 'skip', recommended: false }
    ], rl, 0);

    if (choice.value === 'skip') {
        return;
    }

    console.log('');
    runRepoCommand(getNpmCommand(), ['audit'], { stdio: 'inherit' });
    if (choice.value === 'full') {
        runRepoCommand(getNpmCommand(), ['test', '--', '--runInBand'], { stdio: 'inherit' });
        runRepoCommand(getNpmCommand(), ['run', 'docs:build'], { stdio: 'inherit' });
    }
}

function updateVersion(targetVersion) {
    printSection('更新版本');
    runRepoCommand(getNpmCommand(), ['version', targetVersion, '--no-git-tag-version'], { stdio: 'inherit' });
}

function installDependencies() {
    printSection('安装依赖');
    runRepoCommand(getNpmCommand(), ['install'], { stdio: 'inherit' });
}

function printCommitDiffHint() {
    printSection('提交文案');
    console.log(`
下一步请生成提交文案。

可直接在当前 Codex 会话中执行:
  $commit-diff

拿到文案后，把完整代码块粘贴到下面，最后单独输入 EOF 结束。
`);
}

function extractCommitMessageBuffer(buffer) {
    const normalized = String(buffer || '').replace(/\r/g, '');
    if (normalized === 'EOF' || normalized === 'EOF\n') {
        return { done: true, content: '' };
    }
    const marker = '\nEOF\n';
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
        return { done: true, content: normalized.slice(0, markerIndex) };
    }
    if (normalized.endsWith('\nEOF')) {
        return { done: true, content: normalized.slice(0, -4) };
    }
    return { done: false, content: normalized };
}

async function readCommitMessageFromStdin() {
    return new Promise((resolve) => {
        let buffer = '';
        function cleanup() {
            process.stdin.removeListener('data', onData);
            process.stdin.pause();
        }
        function onData(chunk) {
            buffer += String(chunk || '');
            const result = extractCommitMessageBuffer(buffer);
            if (!result.done) {
                return;
            }
            cleanup();
            resolve(result.content);
        }
        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
}

async function readCommitMessage() {
    printCommitDiffHint();
    const normalized = normalizeCommitMessage(await readCommitMessageFromStdin());
    if (!normalized) {
        throw new Error('提交文案不能为空');
    }
    return normalized;
}

function getCommitDiffManyoyoArgs(authPath) {
    return [
        path.join(REPO_ROOT, 'bin', 'manyoyo.js'),
        'run',
        '--rm-on-exit',
        '-q',
        'full',
        '-y',
        'cx',
        '-v',
        `${authPath}:/root/.codex/auth.json`,
        '--ss',
        "exec --skip-git-repo-check --json '$commit-diff'"
    ];
}

function tryGenerateCommitMessageWithManyoyo() {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) {
        return { message: null, reason: `未检测到 Codex 认证文件: ${authPath}` };
    }
    try {
        const args = getCommitDiffManyoyoArgs(authPath);
        const result = spawnSync(process.execPath, args, {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: COMMIT_DIFF_MANYOYO_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024
        });
        if (RELEASE_DEBUG) {
            console.log('\n[release-debug] manyoyo args:');
            console.log(`${process.execPath} ${args.join(' ')}`);
            console.log('\n[release-debug] manyoyo stdout:');
            console.log(result.stdout || '(empty)');
            console.log('\n[release-debug] manyoyo stderr:');
            console.log(result.stderr || '(empty)');
        }
        if (result.error && result.error.code === 'ETIMEDOUT') {
            const detail = shortenBlock([result.stdout, result.stderr].filter(Boolean).join('\n\n'));
            return { message: null, reason: `调用 manyoyo 容器超时（>${Math.floor(COMMIT_DIFF_MANYOYO_TIMEOUT_MS / 1000)} 秒）${detail ? `\n${detail}` : ''}` };
        }
        if (result.error) {
            const detail = shortenBlock([result.stdout, result.stderr].filter(Boolean).join('\n\n'));
            return { message: null, reason: `${result.error.message || '调用 manyoyo 容器失败'}${detail ? `\n${detail}` : ''}` };
        }
        if (result.status !== 0) {
            const detail = shortenBlock([result.stdout, result.stderr].filter(Boolean).join('\n\n'));
            return { message: null, reason: `manyoyo 退出码 ${result.status}${detail ? `\n${detail}` : ''}` };
        }
        const message = normalizeCommitMessage(extractAgentMessageFromCodexJsonl(result.stdout || ''));
        if (!message) {
            const detail = shortenBlock([result.stdout, result.stderr].filter(Boolean).join('\n\n'));
            return { message: null, reason: `未提取到最终提交文案${detail ? `\n${detail}` : ''}` };
        }
        return { message, reason: '' };
    } catch (error) {
        return { message: null, reason: error.message || '调用 manyoyo 容器失败' };
    }
}

async function chooseCommitMessageSource(rl) {
    printSection('提交文案生成方式');
    return askChoice('', [
        { label: '自动通过 manyoyo run 在容器内执行 commit-diff skill (若失败则执行选项2)', value: 'auto', recommended: true },
        { label: '手动在codex里执行 $commit-diff 并手动粘贴', value: 'manual', recommended: false }
    ], rl, 0);
}

async function acquireCommitMessage(rl) {
    const method = await chooseCommitMessageSource(rl);
    if (method.value === 'auto') {
        console.log('\n正在通过 manyoyo 容器自动生成提交文案...');
        console.log(`将使用容器内 Codex 与当前仓库上下文，最长等待 ${Math.floor(COMMIT_DIFF_MANYOYO_TIMEOUT_MS / 1000)} 秒。`);
        const result = tryGenerateCommitMessageWithManyoyo();
        if (result.message) {
            console.log('已生成提交文案。');
            return result.message;
        }
        console.log(`自动生成失败：${result.reason || '未知原因'}`);
        console.log('已回退到手动粘贴。');
    }

    rl.close();
    const message = await readCommitMessage();
    return message;
}

function commitAllChanges(message) {
    printSection('提交代码');
    runRepoCommand('git', ['add', '-A'], { stdio: 'inherit' });
    runRepoCommand('git', ['commit', '-F', '-'], { stdio: 'inherit', input: `${message}\n` });
}

function hasOriginRemote() {
    return Boolean(runRepoCommand('git', ['remote']).split(/\r?\n/).map(item => item.trim()).find(item => item === 'origin'));
}

function getCurrentBranch() {
    return runRepoCommand('git', ['branch', '--show-current']).trim();
}

async function handleTagAndPush(targetVersion, rl) {
    printSection('推送与标签');
    const hasOrigin = hasOriginRemote();
    if (!hasOrigin) {
        console.log('未检测到 origin 远端，已跳过推送分支与 tag。');
    } else {
        const branch = getCurrentBranch();
        if (branch && await askYesNo(`推送当前分支 ${branch} 到 origin ?`, rl, true)) {
            runRepoCommand('git', ['push', 'origin', branch], { stdio: 'inherit' });
        }
    }

    if (!await askYesNo(`创建 lightweight tag v${targetVersion} ?`, rl, true)) {
        return;
    }

    runRepoCommand('git', ['tag', `v${targetVersion}`], { stdio: 'inherit' });

    if (!hasOrigin) {
        console.log('未检测到 origin 远端，已跳过推送 tag。');
        return;
    }

    if (await askYesNo(`推送 tag v${targetVersion} 到 origin ?`, rl, true)) {
        runRepoCommand('git', ['push', 'origin', `v${targetVersion}`], { stdio: 'inherit' });
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }

    let directVersion = null;
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--version') {
            directVersion = args[index + 1] || null;
            break;
        }
    }
    if (args.includes('--version') && !directVersion) {
        throw new Error('--version 需要提供 x.y.z');
    }

    if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
        throw new Error('当前目录不是 manyoyo git 仓库');
    }

    const currentVersion = readPackageJson().version;
    const latestTagInfo = getLatestTagInfo();
    const status = runRepoCommand('git', ['status', '--short']).trim();
    printState(currentVersion, latestTagInfo, status);
    let rl = createInterface();

    try {
        if (status && !await askYesNo('工作区有未提交改动，继续吗？', rl, false)) {
            return;
        }

        printSection('选择版本');
        const targetVersion = await chooseTargetVersion(currentVersion, latestTagInfo, rl, directVersion);
        checkExistingTag(targetVersion);
        console.log(`目标版本: ${targetVersion}`);

        if (targetVersion !== currentVersion) {
            if (!await askYesNo(`更新 package.json/package-lock.json 到 ${targetVersion} ?`, rl, true)) {
                console.log('已取消版本更新。');
                return;
            }
            updateVersion(targetVersion);
            installDependencies();
        }

        await maybeRunChecks(rl);
        const commitMessage = await acquireCommitMessage(rl);
        rl = createInterface();
        console.log('\n将使用以下 commit 文案:\n');
        console.log(commitMessage);
        if (!await askYesNo('\n继续提交当前改动吗？', rl, true)) {
            console.log('已取消提交。');
            return;
        }

        commitAllChanges(commitMessage);
        await handleTagAndPush(targetVersion, rl);
    } finally {
        rl.close();
    }
}

main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
});
