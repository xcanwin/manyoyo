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
const { buildContainerRunArgs } = require('../../../lib/container-run');
const { createNetworkManager, NETWORK_NAME } = require('../../../lib/container-network');
const { normalizePolicy } = require('../../../lib/network-policy');
const { sidecarName } = require('../../../lib/egress-sidecar');
const containerState = require('../../../lib/container-state');
const { buildExecArgs } = require('../../../lib/container-exec');
const { googleChromeCandidates } = require('../../../lib/plugin/playwright');

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

// 测试里“模拟用户自己的 Chrome”：宿主机有 Google Chrome 就用它，否则用 patchright 的 Chromium（与 headed 模式的退回规则一致）
function simulatedUserChromeOptions() {
    return googleChromeCandidates().some(file => fs.existsSync(file)) ? { channel: 'chrome' } : {};
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

// 与 manyoyo run 创建会话容器相同的路径：集成参数 + 状态目录 + manyoyo 网络 + 默认 restricted 规则。
// 夹具 / 假代理跑在宿主机上，要用 hostPorts 放行（restricted 默认不让容器访问宿主机其他端口）。
async function createContainer(runtime, home, name, { env = [], hostPorts = [], network = {} } = {}) {
    const integration = await buildContainerIntegration({
        homeDir: home,
        runtimeCommand: runtime,
        envEntries: env
    });
    const merged = mergeIntegration({
        containerEnvs: [],
        containerVolumes: [],
        containerExtraArgs: []
    }, integration);
    const policy = normalizePolicy({ ...network, host: [...(network.host || []), ...hostPorts.map(port => ({ ports: String(port) }))] });
    const st = containerState.createState({
        homeDir: home,
        envLines: env,
        network: policy,
        netRequired: policy.preset !== 'open',
        meta: { name }
    });
    const manager = createNetworkManager({ command: runtime, homeDir: home, imageRef: () => IMAGE });
    await manager.ensureBridgeNetwork();
    const result = await run(runtime, buildContainerRunArgs({
        state: st,
        containerName: name,
        hostPath: os.tmpdir(),
        containerPath: '/tmp/manyoyo-it-work',
        imageName: IMAGE.split(':')[0],
        imageVersion: IMAGE.split(':')[1],
        defaultNetwork: NETWORK_NAME,
        containerExtraArgs: merged.containerExtraArgs,
        containerEnvs: merged.containerEnvs,
        containerVolumes: merged.containerVolumes,
        defaultCommand: '/bin/bash'
    }));
    if (result.status !== 0) {
        throw new Error(`创建容器失败: ${result.stderr}`);
    }
    containerHomes.set(name, home);
    await manager.apply(name, { expectId: st.id });
    return name;
}

// 与 manyoyo 的 exec 一致：用户 env 来自状态目录，经 buildExecArgs 每次现读
const containerHomes = new Map();

async function exec(runtime, name, command, options = {}) {
    const home = containerHomes.get(name);
    if (!home) return run(runtime, ['exec', name, 'sh', '-c', command], options);
    const built = buildExecArgs({ homeDir: home, dockerExecArgs: args => spawnSync(runtime, args, { encoding: 'utf-8' }).stdout }, name, { command: ['sh', '-c', command] });
    try {
        return await run(runtime, built.args, options);
    } finally {
        built.cleanup();
    }
}

function removeContainer(runtime, name) {
    spawnSync(runtime, ['rm', '-f', name], { stdio: 'ignore' });
    // allowlist 容器会带起这个 HOME 专属的过滤代理 sidecar
    const home = containerHomes.get(name);
    if (home) spawnSync(runtime, ['rm', '-f', sidecarName(home)], { stdio: 'ignore' });
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
    simulatedUserChromeOptions,
    hostAlias,
    imageAvailable,
    makeHome,
    openAndSnapshot,
    randomName,
    removeContainer,
    run,
    usableRuntime
};
