#!/usr/bin/env node
'use strict';

// npm run release：启动发布控制台（固定端口 127.0.0.1:3900，用完 Ctrl-C 或页面上“结束”即退出）。
//   npm run release                 启动控制台并打开浏览器
//   npm run release -- --status     只在终端打印各阶段状态，不启动服务
//   npm run release -- --dry-run    对外动作只打印命令、不执行（先彩排一遍）
//   npm run release -- --no-open    不自动打开浏览器
//   npm run release -- --port 3901  换端口

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { createReleaseServer, DEFAULT_PORT, HOST } = require('./server');
const { collectFacts } = require('./facts');
const { computeStages } = require('./stages');
const { createBaseContext } = require('./context');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ICON = { done: '✓', todo: '○', blocked: '✗', warn: '!' };

function parseArgs(argv) {
    const args = { status: false, dryRun: false, open: true, port: DEFAULT_PORT, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--status') args.status = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--no-open') args.open = false;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--port') args.port = Number(argv[++i]);
        else throw new Error(`未知参数: ${arg}`);
    }
    if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port 必须是 1–65535 的整数');
    return args;
}

function helpText() {
    return `manyoyo 发布控制台（维护者工具，不属于面向用户的 CLI）

用法:
  npm run release                 启动控制台（127.0.0.1:${DEFAULT_PORT}）并打开浏览器
  npm run release -- --status     只在终端打印各阶段状态
  npm run release -- --dry-run    对外动作只打印命令、不执行
  npm run release -- --no-open    不自动打开浏览器
  npm run release -- --port <n>   换端口

页面上可以逐阶段执行，也可以一键执行“合并 main → 验证”整段（逐步确认或一次确认）。
对外动作（推送、合并、触发 workflow、Release）每次都会列出将执行的命令并要求确认。
`;
}

async function printStatus() {
    const base = createBaseContext({ repoRoot: REPO_ROOT });
    const facts = await collectFacts(base);
    const stages = computeStages(facts, base.state.load());
    console.log(`版本 ${facts.pkg.version}（最近发布 ${facts.git.latestTag || '无'}），分支 ${facts.git.branch || '(分离)'}\n`);
    for (const stage of stages) console.log(`${ICON[stage.state] || '?'} ${stage.title}：${stage.detail}`);
    const next = stages.find(stage => stage.state === 'todo' || stage.state === 'warn');
    console.log(next ? `\n下一步：${next.title}（npm run release 打开控制台）` : '\n全部完成');
}

function openBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
        const child = spawn(command, [url], { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
    } catch (error) {
        // 打不开就只打印地址
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return console.log(helpText());
    if (args.status) return printStatus();

    if (!fs.existsSync(path.join(__dirname, 'console.html'))) {
        console.log('首次使用：构建控制台页面（npm run build:release）…');
        const built = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'web.js'), 'build-release'], { cwd: REPO_ROOT, stdio: 'inherit' });
        if (built.status !== 0) throw new Error('控制台页面构建失败');
    }

    const app = createReleaseServer({ repoRoot: REPO_ROOT, port: args.port, dryRun: args.dryRun, onQuit: () => process.exit(0) });
    let info;
    try {
        info = await app.listen();
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            const alive = await fetch(`http://${HOST}:${args.port}/api/ping`).then(res => res.json()).catch(() => null);
            if (alive && alive.app === 'manyoyo-release-console') throw new Error(`发布控制台已在运行（端口 ${args.port}）。请回到启动它的终端取完整地址，或先在页面上点“结束”。`);
            throw new Error(`端口 ${args.port} 被其他程序占用，可以用 --port 换一个。`);
        }
        throw error;
    }
    console.log(`发布控制台已启动${args.dryRun ? '（dry-run：对外动作只打印命令）' : ''}\n  ${info.url}\n用完按 Ctrl-C 或在页面上点“结束”。`);
    if (args.open) openBrowser(info.url);
    process.on('SIGINT', () => process.exit(0));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message || error);
        process.exit(1);
    });
}

module.exports = { parseArgs };
