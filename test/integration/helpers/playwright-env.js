'use strict';

// Playwright 模式集成测试的公共设施：运行时探测、起容器（带插件注入的参数）、异步执行命令。
// 被测命令都用异步 spawn：夹具 HTTP 服务跑在测试进程里，spawnSync 会把它卡死。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { imageVersion } = require('../../../package.json');
const { buildContainerIntegration, mergeIntegration } = require('../../../lib/plugin');

const BIN_PATH = path.join(__dirname, '../../../bin/manyoyo.js');
const IMAGE = `ghcr.io/xcanwin/manyoyo:${imageVersion}`;

function usableRuntime() {
    for (const candidate of ['podman', 'docker']) {
        const probe = spawnSync(candidate, ['info'], { stdio: 'ignore', timeout: 15000 });
        if (probe.status === 0) {
            return candidate;
        }
    }
    return '';
}

function imageAvailable(runtime) {
    return spawnSync(runtime, ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
}

function hasDisplay() {
    return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function run(command, args, { env = {}, timeout = 120000, input } = {}) {
    return new Promise(resolve => {
        const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
        child.stdin.end(input || '');
    });
}

// 临时 HOME 下跑 manyoyo；podman 的镜像仓库留在真实 HOME，浏览器缓存也共用真实 HOME
function cli(home, args, options = {}) {
    const real = os.homedir();
    return run(process.execPath, [BIN_PATH, ...args], {
        ...options,
        env: {
            HOME: home,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(real, '.local', 'share'),
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(real, '.config'),
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(real, '.cache', 'ms-playwright'),
            ...(options.env || {})
        }
    });
}

function makeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-pw-it-'));
    fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
    return home;
}

function freePort() {
    return new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '0.0.0.0', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function hostAlias(runtime) {
    return runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

// 与 manyoyo run 创建会话容器相同的集成参数
async function createContainer(runtime, home, name, { env = [] } = {}) {
    const integration = await buildContainerIntegration({
        homeDir: home,
        runtimeCommand: runtime,
        envEntries: env
    });
    const merged = mergeIntegration({
        containerEnvs: env.flatMap(entry => ['--env', entry]),
        containerVolumes: [],
        containerExtraArgs: []
    }, integration);
    const result = await run(runtime, [
        'run', '-d', '--name', name, '--entrypoint', '',
        ...merged.containerExtraArgs, ...merged.containerEnvs, ...merged.containerVolumes,
        IMAGE, 'tail', '-f', '/dev/null'
    ]);
    if (result.status !== 0) {
        throw new Error(`创建容器失败: ${result.stderr}`);
    }
    return name;
}

function exec(runtime, name, command, options = {}) {
    return run(runtime, ['exec', name, 'sh', '-c', command], options);
}

function removeContainer(runtime, name) {
    spawnSync(runtime, ['rm', '-f', name], { stdio: 'ignore' });
}

function randomName(prefix) {
    return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

// 容器里打开页面并读回快照；用完关闭会话
async function openAndSnapshot(runtime, name, url) {
    const open = await exec(runtime, name, `playwright-cli open ${url}`, { timeout: 90000 });
    const snapshot = await exec(runtime, name, 'playwright-cli snapshot', { timeout: 60000 });
    await exec(runtime, name, 'playwright-cli close', { timeout: 30000 });
    return { open, snapshot, text: `${open.stdout}${snapshot.stdout}` };
}

module.exports = {
    BIN_PATH,
    IMAGE,
    cli,
    createContainer,
    exec,
    freePort,
    hasDisplay,
    hostAlias,
    imageAvailable,
    makeHome,
    openAndSnapshot,
    randomName,
    removeContainer,
    run,
    usableRuntime
};
