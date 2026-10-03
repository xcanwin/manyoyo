'use strict';

// 安装完成后的“下一步”：由安装包调用 `manyoyo --post-install [--headless|--gui]`（隐藏入口，不在帮助里）。
//   有图形界面            直接启动网页服务并打开浏览器
//   无头 + 有终端         问一次：1 在终端里配置（manyoyo setup）/ 2 启动网页版（SSH 端口转发）/ 3 先不配置
//   无头 + 没有终端       只安装，不启动任何服务，打印下一步（脚本、CI、ssh host '…' 的场景）
// 另外会提示：PATH 里还有另一份 manyoyo、还在运行旧版代码的 serve。所有 IO 注入，便于测试。

const fs = require('fs');
const path = require('path');
const { inspectScript, findOutdatedInstances, restartCommand, sourceLabel } = require('./serve-instances');

/**
 * PATH 里除 ownRoot（~/.manyoyo）之外的其他 manyoyo 可执行文件，按真实路径去重。
 */
function findOtherManyoyo({ pathEnv = process.env.PATH || '', ownRoot, currentVersion = '' } = {}) {
    const seen = new Set();
    const result = [];
    // home 可能经过符号链接（如 /home → /var/home）：realpath 后的路径要和解析后的 ownRoot 比
    let realOwnRoot = ownRoot || '';
    try {
        if (ownRoot) realOwnRoot = fs.realpathSync(ownRoot);
    } catch (error) {
        // 目录不存在：按原样比较
    }
    for (const dir of String(pathEnv).split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, 'manyoyo');
        let real;
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            real = fs.realpathSync(candidate);
        } catch (error) {
            continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        if (ownRoot && (real.startsWith(`${ownRoot}${path.sep}`) || real.startsWith(`${realOwnRoot}${path.sep}`))) continue;
        const info = inspectScript(real);
        if (info.version && info.version === currentVersion && info.source === 'offline') continue;
        result.push({ path: candidate, version: info.version, source: info.source });
    }
    return result;
}

function otherManyoyoNotice(others, currentVersion) {
    if (others.length === 0) return [];
    const lines = ['', '提示：这台机器上还有另一份 manyoyo'];
    for (const item of others) {
        const detail = [item.version || '版本未知', sourceLabel(item.source)].join('，');
        lines.push(`  ${item.path}（${detail}）`);
    }
    lines.push(`  新开终端后，输入 manyoyo 会优先使用本次的 ${currentVersion}；另一份不会被改动。`);
    return lines;
}

function outdatedServeNotice(instances, currentVersion) {
    const outdated = findOutdatedInstances(instances, currentVersion);
    if (outdated.length === 0) return [];
    const lines = ['', '提示：有 serve 还在运行旧版代码，需要重启才会换成新版'];
    for (const item of outdated) {
        lines.push(`  ${item.listen}（pid ${item.pid}，版本 ${item.version || '未知'}，${sourceLabel(item.source)}）`);
    }
    const hasMaskedPassword = outdated.some(item => item.args.includes('******'));
    lines.push(`  重启命令${hasMaskedPassword ? '（把 ****** 换成你原来的密码）' : ''}：`);
    for (const item of outdated) lines.push(`  ${restartCommand(item)}`);
    return lines;
}

const CHOICES = [
    '在终端里配置（推荐）',
    '启动网页版，用你自己电脑的浏览器访问（需要 SSH 端口转发）',
    '先不配置，以后自己运行 manyoyo setup'
];

async function askChoice(ask, log) {
    log('');
    log('这台机器没有图形界面，怎么完成首次配置？');
    CHOICES.forEach((text, index) => log(`  ${index + 1}) ${text}`));
    for (;;) {
        let answer;
        try {
            answer = String(await ask('请选择 [默认选1]: ')).trim();
        } catch (error) {
            return 3; // 输入被中断（Ctrl-D / stdin 关闭）：按“先不配置”处理
        }
        if (answer === '') return 1;
        if (['1', '2', '3'].includes(answer)) return Number(answer);
        log('请输入 1、2 或 3。');
    }
}

function installedOnlyHint(log, name) {
    log('');
    log('已安装，没有启动任何服务。之后：');
    log(`  ${name} setup   在终端里配置`);
    log(`  ${name}         启动网页版（无图形界面时会告诉你怎么转发端口）`);
}

/**
 * @param {object} deps
 *   headless, interactive, currentVersion, ownRoot, commandName
 *   ask(prompt) → Promise<string>、log(line)
 *   startApp() → Promise  启动（或复用）网页服务；有头时打开浏览器
 *   runSetup() → Promise<number>  manyoyo setup 的退出码
 *   findOthers() → [] / listServes() → []（默认读真实环境）
 */
async function runPostInstall(deps) {
    const { headless, interactive, currentVersion, log, ask } = deps;
    const name = deps.commandName || 'manyoyo';
    const others = deps.findOthers ? deps.findOthers() : findOtherManyoyo({ ownRoot: deps.ownRoot, currentVersion });
    otherManyoyoNotice(others, currentVersion).forEach(line => log(line));

    if (!headless) {
        await deps.startApp();
    } else if (!interactive) {
        installedOnlyHint(log, name);
    } else {
        const choice = await askChoice(ask, log);
        if (choice === 1) {
            log('');
            const code = await deps.runSetup();
            if (code === 0) {
                log('');
                log('✓ 配置完成。常用命令：');
                log(`  ${name} run -y c      在沙箱里启动 Claude Code`);
                log(`  ${name}               启动网页服务，打开网页版（无图形界面时会告诉你怎么转发端口）`);
                log(`  ${name} serve --list  查看正在运行的 serve`);
            } else {
                log(`配置没有完成，之后运行 ${name} setup 重试。`);
            }
        } else if (choice === 2) {
            await deps.startApp();
        } else {
            installedOnlyHint(log, name);
        }
    }

    const serves = deps.listServes ? deps.listServes() : [];
    outdatedServeNotice(serves, currentVersion).forEach(line => log(line));
    return 0;
}

module.exports = { runPostInstall, findOtherManyoyo, otherManyoyoNotice, outdatedServeNotice };
