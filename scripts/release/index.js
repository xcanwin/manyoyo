#!/usr/bin/env node
'use strict';

// npm run release：发布控制台（维护者工具）。人用网页，agent 用命令行，两者共用同一套阶段与门禁。
//   npm run release                              启动网页控制台（127.0.0.1:3900）并打开浏览器
//   npm run release -- --status [--json]         只在终端打印各阶段状态
//   npm run release -- --run <阶段,…> [--yes]    命令行执行阶段（对外动作需要 --yes）
//   npm run release -- --help                    完整用法

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { createReleaseServer, DEFAULT_PORT, HOST } = require('./server');
const { createEngine, printStatus, runStages, runRemote, runRemoteStatus, printNotesDraft, EXIT } = require('./cli');

const REPO_ROOT = path.join(__dirname, '..', '..');
const VALUE_FLAGS = { '--run': 'run', '--notes-file': 'notesFile', '--version': 'version', '--image-version': 'imageVersion', '--files': 'files', '--message': 'message' };

function parseArgs(argv) {
    const args = { status: false, dryRun: false, open: true, port: DEFAULT_PORT, help: false, json: false, yes: false, notesDraft: false, npmDispatch: false, remote: false, watch: false, remoteStatus: false, remoteRunId: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--status') args.status = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--no-open') args.open = false;
        else if (arg === '--json') args.json = true;
        else if (arg === '--yes') args.yes = true;
        else if (arg === '--notes-draft') args.notesDraft = true;
        else if (arg === '--npm-dispatch') args.npmDispatch = true;
        else if (arg === '--remote') args.remote = true;
        else if (arg === '--watch') args.watch = true;
        else if (arg === '--remote-status') {
            args.remoteStatus = true;
            if (argv[i + 1] !== undefined && /^\d+$/.test(argv[i + 1])) args.remoteRunId = argv[++i];
        }
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--port') args.port = Number(argv[++i]);
        else if (VALUE_FLAGS[arg]) {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
            args[VALUE_FLAGS[arg]] = value;
        } else throw new Error(`未知参数: ${arg}`);
    }
    if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port 必须是 1–65535 的整数');
    return args;
}

function helpText() {
    return `manyoyo 发布控制台（维护者工具，不属于面向用户的 CLI）。人用网页，agent 用命令行，共用同一套阶段与门禁。

阶段（按顺序）:
  preflight  预检（本地 build:web / test / docs:check / lint:sh；CI 在同一提交上通过也算）
  version    升版本（--version <x.y.z> [--image-version <x.y.z-后缀>]）
  commit     提交（--files a,b --message "说明"）
  merge*     把当前分支 --no-ff 合并进本地 main 并直接推送 origin/main（没有 PR；需要预检通过，或 CI 在当前提交上通过）
  image*     发布镜像（docker/ 或 imageVersion 有变化才需要；已有 tag 不会被覆盖）
  packages*  构建四个平台的安装包并等待
  release*   创建 Release 草稿，钉在安装包构建的提交上（--notes-file <路径> 必填）
  assets*    把安装包挂到草稿，核对资产与 SHA256SUMS 一致
  publish*   草稿改为公开（这时才创建 tag、成为 latest、触发 npm 发布）
  verify*    发版后在干净 runner 上验证（与 npm 并行）
  npm*       等待 npm 发布并确认可见（--npm-dispatch：没被触发时手动触发）
  * 带星号的是对外动作：命令行必须加 --yes，否则只打印将执行的命令并以退出码 2 结束。--yes 授权的是这一条命令里列出的全部对外阶段，
    授权范围多大就把阶段切成几条命令；preflight、version、commit 不是对外动作，不需要 --yes。

用法:
  npm run release                                 启动网页控制台（127.0.0.1:${DEFAULT_PORT}）并打开浏览器
  npm run release -- --status [--json]            各阶段状态（--json 给 agent 解析）
  npm run release -- --notes-draft > notes.md     生成 Release 说明草稿，编辑后传给 --notes-file
  npm run release -- --run <阶段,阶段…> [--yes]   依次执行阶段，已完成的自动跳过；状态不符合预期就停下
  npm run release -- --dry-run [--run …]          对外动作只打印命令、不执行（先彩排一遍）
  npm run release -- --no-open | --port <n>       网页控制台：不打开浏览器 / 换端口

典型流程（只改代码、镜像不变；已完成的阶段会自动跳过，重跑不会出错）:
  npm run release -- --run version --version 8.3.2
  npm run release -- --run commit --files package.json,package-lock.json --message "升级版本到 8.3.2"
  git push -u origin <分支>                       # 需要授权；推送后 ci.yml 在该提交上通过，就等价于本地预检
  npm run release -- --run preflight              # 不推分支时改用本地预检（约 5 分钟，真跑测试；--dry-run 下也会真跑）
  npm run release -- --run merge,packages --yes   # 镜像有变化时在前面加 image
  npm run release -- --notes-draft > notes.md     # 编辑 notes.md（模板里的英文部分也要写）
  npm run release -- --run release,assets,publish,verify,npm --yes --notes-file notes.md
  npm run release -- --run npm --npm-dispatch --yes   # 仅当 release: published 没触发 npm-publish 时

退出码: 0 成功；1 失败；2 需要 --yes（未执行任何动作）。同一时间只允许一个发布任务（网页与命令行共用锁）。
`;
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

async function cliMain(args) {
    const io = { out: line => console.log(line), err: line => console.error(line) };
    const engine = createEngine({ repoRoot: REPO_ROOT, dryRun: args.dryRun });
    if (args.remote) return runRemote(engine, args, io);
    if (args.remoteStatus) return runRemoteStatus(engine, args, io);
    if (args.notesDraft) {
        await printNotesDraft(engine, io);
        return EXIT.OK;
    }
    if (args.run) return runStages(engine, args, io);
    await printStatus(engine, io, args.json);
    return EXIT.OK;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return console.log(helpText());
    if (args.status || args.run || args.notesDraft || args.remote || args.remoteStatus) {
        process.exitCode = await cliMain(args);
        return undefined;
    }

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
