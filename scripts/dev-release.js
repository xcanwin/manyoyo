#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');
const {
    parseReleaseVersion,
    compareReleaseVersions,
    buildVersionSuggestions,
    pickLatestVersionTag,
    normalizeCommitMessage
} = require('../lib/dev-release');

const REPO_ROOT = path.resolve(__dirname, '..');

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
  3. 提示在 Codex 中执行 $commit-diff 生成提交文案
  4. 粘贴文案后继续提交、打 tag、推送 tag

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
    console.log(`\n${title}`);
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

    const selection = await askChoice('选择目标版本', [
        ...choices,
        { label: '手动输入版本号', value: 'custom', recommended: false }
    ], rl, 0);

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

function printState(currentVersion, latestTagInfo) {
    const branch = runRepoCommand('git', ['branch', '--show-current']).trim() || '(detached HEAD)';
    const latestCommit = runRepoCommand('git', ['show', '-s', '--format=%h %s', 'HEAD']).trim();
    const status = runRepoCommand('git', ['status', '--short']).trim();
    console.log(`当前版本: ${currentVersion}`);
    console.log(`最新标签: ${latestTagInfo ? latestTagInfo.tag : '(无语义化标签)'}`);
    console.log(`当前分支: ${branch}`);
    console.log(`最近提交: ${latestCommit || '(无提交)'}`);
    console.log(`工作区状态: ${status ? '有未提交改动' : '干净'}`);
    if (status) {
        console.log(status);
    }
}

async function maybeRunChecks(rl) {
    const choice = await askChoice('选择发布前检查', [
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
    runRepoCommand(getNpmCommand(), ['version', targetVersion, '--no-git-tag-version'], { stdio: 'inherit' });
}

function installDependencies() {
    runRepoCommand(getNpmCommand(), ['install'], { stdio: 'inherit' });
}

function printCommitDiffHint() {
    console.log(`
下一步请生成提交文案。

可直接在当前 Codex 会话中执行:
  $commit-diff

如果你是在命令行里单独跑，也可以执行:
  codex exec '$commit-diff'

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

function commitAllChanges(message) {
    runRepoCommand('git', ['add', '-A'], { stdio: 'inherit' });
    runRepoCommand('git', ['commit', '-F', '-'], { stdio: 'inherit', input: `${message}\n` });
}

function hasOriginRemote() {
    return Boolean(runRepoCommand('git', ['remote']).split(/\r?\n/).map(item => item.trim()).find(item => item === 'origin'));
}

async function handleTagAndPush(targetVersion, rl) {
    if (!await askYesNo(`创建 lightweight tag v${targetVersion} ?`, rl, true)) {
        return;
    }

    runRepoCommand('git', ['tag', `v${targetVersion}`], { stdio: 'inherit' });

    if (!hasOriginRemote()) {
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
    printState(currentVersion, latestTagInfo);

    const status = runRepoCommand('git', ['status', '--short']).trim();
    let rl = createInterface();

    try {
        if (status && !await askYesNo('工作区有未提交改动，继续吗？', rl, false)) {
            return;
        }

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
        rl.close();
        const commitMessage = await readCommitMessage();
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
