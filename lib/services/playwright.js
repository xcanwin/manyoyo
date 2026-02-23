'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCENE_ORDER = ['cont-headless', 'cont-headed', 'host-headless', 'host-headed'];

const SCENE_DEFS = {
    'cont-headless': {
        type: 'container',
        configFile: 'container-headless.json',
        composeFile: 'compose-headless.yaml',
        projectName: 'my-playwright-cont-headless',
        containerName: 'my-playwright-cont-headless',
        portKey: 'contHeadless',
        headless: true,
        listenHost: '0.0.0.0'
    },
    'cont-headed': {
        type: 'container',
        configFile: 'container-headed.json',
        composeFile: 'compose-headed.yaml',
        projectName: 'my-playwright-cont-headed',
        containerName: 'my-playwright-cont-headed',
        portKey: 'contHeaded',
        headless: false,
        listenHost: '0.0.0.0'
    },
    'host-headless': {
        type: 'host',
        configFile: 'host-headless.json',
        portKey: 'hostHeadless',
        headless: true,
        listenHost: '127.0.0.1'
    },
    'host-headed': {
        type: 'host',
        configFile: 'host-headed.json',
        portKey: 'hostHeaded',
        headless: false,
        listenHost: '127.0.0.1'
    }
};

const VALID_RUNTIME = new Set(['container', 'host', 'mixed']);
const VALID_ACTIONS = new Set(['up', 'down', 'status', 'health', 'logs']);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tailText(filePath, lineCount) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    return lines.slice(-lineCount).join('\n');
}

function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function asStringArray(value, fallback) {
    if (!Array.isArray(value)) {
        return fallback;
    }
    return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

class PlaywrightPlugin {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this.globalConfig = asObject(options.globalConfig);
        this.runConfig = asObject(options.runConfig);
        this.config = this.resolveConfig();
    }

    resolveConfig() {
        const homeDir = os.homedir();
        const defaultConfig = {
            runtime: 'mixed',
            enabledScenes: [...SCENE_ORDER],
            hostListen: '127.0.0.1',
            mcpDefaultHost: 'host.docker.internal',
            dockerTag: process.env.PLAYWRIGHT_MCP_DOCKER_TAG || 'latest',
            npmVersion: process.env.PLAYWRIGHT_MCP_NPM_VERSION || 'latest',
            containerRuntime: 'podman',
            vncPasswordEnvKey: 'VNC_PASSWORD',
            headedImage: 'localhost/xcanwin/manyoyo-playwright-headed',
            configDir: path.join(homeDir, '.manyoyo', 'services', 'playwright', 'config'),
            runDir: path.join(homeDir, '.manyoyo', 'services', 'playwright', 'run'),
            composeDir: path.join(__dirname, 'playwright-assets'),
            ports: {
                contHeadless: 8931,
                contHeaded: 8932,
                hostHeadless: 8933,
                hostHeaded: 8934,
                contHeadedNoVnc: 6080
            }
        };

        const merged = {
            ...defaultConfig,
            ...this.globalConfig,
            ...this.runConfig,
            ports: {
                ...defaultConfig.ports,
                ...asObject(this.globalConfig.ports),
                ...asObject(this.runConfig.ports)
            }
        };

        merged.runtime = String(merged.runtime || defaultConfig.runtime).trim().toLowerCase();
        if (!VALID_RUNTIME.has(merged.runtime)) {
            throw new Error(`playwright.runtime 无效: ${merged.runtime}`);
        }

        merged.enabledScenes = asStringArray(
            this.runConfig.enabledScenes,
            asStringArray(this.globalConfig.enabledScenes, [...defaultConfig.enabledScenes])
        );

        if (merged.enabledScenes.length === 0) {
            throw new Error('playwright.enabledScenes 不能为空');
        }

        const invalidScene = merged.enabledScenes.find(scene => !SCENE_DEFS[scene]);
        if (invalidScene) {
            throw new Error(`playwright.enabledScenes 包含未知场景: ${invalidScene}`);
        }

        return merged;
    }

    writeStdout(line = '') {
        this.stdout.write(`${line}\n`);
    }

    writeStderr(line = '') {
        this.stderr.write(`${line}\n`);
    }

    runCmd(args, { env = null, captureOutput = false, check = true } = {}) {
        const result = spawnSync(args[0], args.slice(1), {
            encoding: 'utf8',
            env: env || process.env,
            stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });

        const completed = {
            returncode: result.status === null ? 1 : result.status,
            stdout: typeof result.stdout === 'string' ? result.stdout : '',
            stderr: typeof result.stderr === 'string' ? result.stderr : ''
        };

        if (result.error) {
            if (check) {
                throw result.error;
            }
            completed.returncode = 1;
            return completed;
        }

        if (check && completed.returncode !== 0) {
            const error = new Error(`command failed with exit code ${completed.returncode}`);
            error.returncode = completed.returncode;
            error.stdout = completed.stdout;
            error.stderr = completed.stderr;
            throw error;
        }

        return completed;
    }

    ensureCommandAvailable(command) {
        const check = this.runCmd([command, '--version'], { captureOutput: true, check: false });
        return check.returncode === 0;
    }

    scenePort(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return Number(this.config.ports[def.portKey]);
    }

    sceneConfigPath(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return path.join(this.config.configDir, def.configFile);
    }

    scenePidFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.pid`);
    }

    sceneLogFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.log`);
    }

    resolveTargets(sceneName = 'all') {
        const requested = String(sceneName || 'all').trim();
        const enabledSet = new Set(this.config.enabledScenes);
        const runtime = this.config.runtime;

        const isAllowedByRuntime = (scene) => {
            const type = SCENE_DEFS[scene].type;
            if (runtime === 'mixed') {
                return true;
            }
            return runtime === type;
        };

        if (requested !== 'all') {
            if (!SCENE_DEFS[requested]) {
                throw new Error(`未知场景: ${requested}`);
            }
            if (!enabledSet.has(requested)) {
                throw new Error(`场景未启用: ${requested}`);
            }
            if (!isAllowedByRuntime(requested)) {
                throw new Error(`当前 runtime=${runtime}，不允许场景: ${requested}`);
            }
            return [requested];
        }

        return SCENE_ORDER
            .filter(scene => enabledSet.has(scene))
            .filter(scene => isAllowedByRuntime(scene));
    }

    buildSceneConfig(sceneName) {
        const def = SCENE_DEFS[sceneName];
        const port = this.scenePort(sceneName);

        return {
            server: {
                host: def.listenHost,
                port,
                allowedHosts: [
                    `localhost:${port}`,
                    `127.0.0.1:${port}`,
                    `host.docker.internal:${port}`,
                    `host.containers.internal:${port}`
                ]
            },
            browser: {
                chromiumSandbox: true,
                browserName: 'chromium',
                launchOptions: {
                    channel: 'chromium',
                    headless: def.headless
                },
                contextOptions: {
                    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
                }
            }
        };
    }

    ensureSceneConfig(sceneName) {
        fs.mkdirSync(this.config.configDir, { recursive: true });
        const payload = this.buildSceneConfig(sceneName);
        const filePath = this.sceneConfigPath(sceneName);
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
        return filePath;
    }

    async portReady(port) {
        return await new Promise((resolve) => {
            let settled = false;
            const socket = net.createConnection({ host: '127.0.0.1', port });

            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                resolve(value);
            };

            socket.setTimeout(300);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    async waitForPort(port) {
        for (let i = 0; i < 30; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            if (await this.portReady(port)) {
                return true;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(500);
        }
        return false;
    }

    containerEnv(sceneName, cfgPath, options = {}) {
        const def = SCENE_DEFS[sceneName];
        const requireVncPassword = options.requireVncPassword === true;
        const env = {
            ...process.env,
            PLAYWRIGHT_MCP_DOCKER_TAG: this.config.dockerTag,
            PLAYWRIGHT_MCP_PORT: String(this.scenePort(sceneName)),
            PLAYWRIGHT_MCP_CONFIG_PATH: cfgPath,
            PLAYWRIGHT_MCP_CONTAINER_NAME: def.containerName,
            PLAYWRIGHT_MCP_IMAGE: this.config.headedImage,
            PLAYWRIGHT_MCP_NOVNC_PORT: String(this.config.ports.contHeadedNoVnc)
        };

        if (sceneName === 'cont-headed') {
            const envKey = this.config.vncPasswordEnvKey;
            const password = process.env[envKey];
            if (!password && requireVncPassword) {
                throw new Error(`${envKey} is required for cont-headed`);
            }
            // podman-compose resolves ${VNC_PASSWORD:?..} even for `down`.
            // Keep `up` strict, but use a non-empty placeholder for non-up actions.
            env.VNC_PASSWORD = password || '__MANYOYO_PLACEHOLDER__';
        }

        return env;
    }

    containerComposePath(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return path.join(this.config.composeDir, def.composeFile);
    }

    async startContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[up] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const cfgPath = this.ensureSceneConfig(sceneName);
        const env = this.containerEnv(sceneName, cfgPath, { requireVncPassword: true });
        const def = SCENE_DEFS[sceneName];

        try {
            this.runCmd([
                runtime,
                'compose',
                '-p',
                def.projectName,
                '-f',
                this.containerComposePath(sceneName),
                'up',
                '-d'
            ], { env, check: true });
        } catch (error) {
            return error.returncode || 1;
        }

        const port = this.scenePort(sceneName);
        if (await this.waitForPort(port)) {
            this.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port}`);
            return 0;
        }

        this.writeStderr(`[up] ${sceneName} did not become ready on 127.0.0.1:${port}`);
        return 1;
    }

    stopContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[down] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const cfgPath = this.sceneConfigPath(sceneName);
        const env = this.containerEnv(sceneName, cfgPath);
        const def = SCENE_DEFS[sceneName];

        try {
            this.runCmd([
                runtime,
                'compose',
                '-p',
                def.projectName,
                '-f',
                this.containerComposePath(sceneName),
                'down'
            ], { env, check: true });
        } catch (error) {
            return error.returncode || 1;
        }

        this.writeStdout(`[down] ${sceneName}`);
        return 0;
    }

    statusContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[status] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const def = SCENE_DEFS[sceneName];
        const cp = this.runCmd([
            runtime,
            'ps',
            '--filter',
            `name=${def.containerName}`,
            '--format',
            '{{.Names}}'
        ], { captureOutput: true, check: false });

        const names = new Set(
            cp.stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
        );

        if (names.has(def.containerName)) {
            this.writeStdout(`[status] ${sceneName} running`);
        } else {
            this.writeStdout(`[status] ${sceneName} stopped`);
        }
        return 0;
    }

    logsContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[logs] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const def = SCENE_DEFS[sceneName];
        const cp = this.runCmd([
            runtime,
            'logs',
            '--tail',
            '80',
            def.containerName
        ], { captureOutput: true, check: false });

        const output = cp.stdout || cp.stderr;
        if (output.trim()) {
            this.writeStdout(output.trimEnd());
        } else {
            this.writeStdout(`[logs] ${sceneName} no logs`);
        }

        return cp.returncode === 0 ? 0 : 1;
    }

    spawnHostProcess(cfgPath, logFd) {
        return spawn('npx', [`@playwright/mcp@${this.config.npmVersion}`, '--config', String(cfgPath)], {
            detached: true,
            stdio: ['ignore', logFd, logFd]
        });
    }

    stopHostStarter(pid) {
        if (!Number.isInteger(pid) || pid <= 0) {
            return;
        }
        try {
            process.kill(-pid, 'SIGTERM');
            return;
        } catch {
            // no-op
        }
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // no-op
        }
    }

    hostScenePids(sceneName) {
        const cfgPath = this.sceneConfigPath(sceneName);
        const pattern = `playwright-mcp.*--config ${cfgPath}`;
        const cp = this.runCmd(['pgrep', '-f', pattern], { captureOutput: true, check: false });

        if (cp.returncode !== 0 || !cp.stdout.trim()) {
            return [];
        }

        const pids = [];
        for (const line of cp.stdout.split(/\r?\n/)) {
            const text = line.trim();
            if (/^\d+$/.test(text)) {
                pids.push(Number(text));
            }
        }
        return pids;
    }

    async waitForHostPids(sceneName, fallbackPid) {
        for (let i = 0; i < 5; i += 1) {
            const pids = this.hostScenePids(sceneName);
            if (pids.length > 0) {
                return pids;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }
        if (Number.isInteger(fallbackPid) && fallbackPid > 0) {
            return [fallbackPid];
        }
        return [];
    }

    async startHost(sceneName) {
        if (!this.ensureCommandAvailable('npx')) {
            this.writeStderr(`[up] ${sceneName} failed: npx command not found.`);
            return 1;
        }

        fs.mkdirSync(this.config.runDir, { recursive: true });
        const cfgPath = this.ensureSceneConfig(sceneName);
        const pidFile = this.scenePidFile(sceneName);
        const logFile = this.sceneLogFile(sceneName);
        const port = this.scenePort(sceneName);

        let managedPids = this.hostScenePids(sceneName);
        if (managedPids.length > 0 && (await this.portReady(port))) {
            this.writeStdout(`[up] ${sceneName} already running (pid(s) ${managedPids.join(' ')})`);
            return 0;
        }

        if (await this.portReady(port)) {
            this.writeStderr(`[up] ${sceneName} failed: port ${port} is already in use by another process.`);
            this.writeStderr('Stop the conflicting process first, then retry.');
            return 1;
        }

        fs.rmSync(pidFile, { force: true });
        const logFd = fs.openSync(logFile, 'a');
        const starter = this.spawnHostProcess(cfgPath, logFd);
        fs.closeSync(logFd);
        if (typeof starter.unref === 'function') {
            starter.unref();
        }

        if (await this.waitForPort(port)) {
            managedPids = await this.waitForHostPids(sceneName, starter.pid);
            if (managedPids.length > 0) {
                fs.writeFileSync(pidFile, `${managedPids[0]}`, 'utf8');
                this.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port} (pid(s) ${managedPids.join(' ')})`);
                return 0;
            }
        }

        this.writeStderr(`[up] ${sceneName} failed to start. tail ${logFile}:`);
        const tail = tailText(logFile, 30);
        if (tail) {
            this.writeStderr(tail);
        }

        if (starter.exitCode === null && !starter.killed) {
            this.stopHostStarter(starter.pid);
        }

        return 1;
    }

    async stopHost(sceneName) {
        const pidFile = this.scenePidFile(sceneName);
        const port = this.scenePort(sceneName);
        const managedPids = this.hostScenePids(sceneName);

        for (const pid of managedPids) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // no-op
            }
        }

        if (managedPids.length > 0) {
            await sleep(300);
        }

        if (fs.existsSync(pidFile)) {
            const text = fs.readFileSync(pidFile, 'utf8').trim();
            if (/^\d+$/.test(text)) {
                try {
                    process.kill(Number(text), 'SIGTERM');
                } catch {
                    // no-op
                }
            }
            fs.rmSync(pidFile, { force: true });
        }

        if (await this.portReady(port)) {
            this.writeStderr(`[down] ${sceneName} warning: port ${port} is still in use (possibly unmanaged process)`);
            return 1;
        }

        this.writeStdout(`[down] ${sceneName}`);
        return 0;
    }

    async statusHost(sceneName) {
        const pidFile = this.scenePidFile(sceneName);
        const port = this.scenePort(sceneName);
        const managedPids = this.hostScenePids(sceneName);

        if (managedPids.length > 0 && (await this.portReady(port))) {
            this.writeStdout(`[status] ${sceneName} running (pid(s) ${managedPids.join(' ')})`);
            const pidfileValid = fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim());
            if (!pidfileValid) {
                fs.mkdirSync(path.dirname(pidFile), { recursive: true });
                fs.writeFileSync(pidFile, `${managedPids[0]}`, 'utf8');
            }
            return 0;
        }

        if (managedPids.length > 0 && !(await this.portReady(port))) {
            this.writeStdout(`[status] ${sceneName} degraded (pid(s) ${managedPids.join(' ')}, port ${port} not reachable)`);
            return 0;
        }

        fs.rmSync(pidFile, { force: true });
        if (await this.portReady(port)) {
            this.writeStdout(`[status] ${sceneName} conflict (port ${port} in use by unmanaged process)`);
        } else {
            this.writeStdout(`[status] ${sceneName} stopped`);
        }
        return 0;
    }

    async healthScene(sceneName) {
        const port = this.scenePort(sceneName);
        if (await this.portReady(port)) {
            this.writeStdout(`[health] ${sceneName} ok (127.0.0.1:${port})`);
            return 0;
        }
        this.writeStdout(`[health] ${sceneName} fail (127.0.0.1:${port})`);
        return 1;
    }

    logsHost(sceneName) {
        const logFile = this.sceneLogFile(sceneName);
        if (!fs.existsSync(logFile)) {
            this.writeStdout(`[logs] ${sceneName} no log file: ${logFile}`);
            return 0;
        }

        const tail = tailText(logFile, 80);
        if (tail) {
            this.writeStdout(tail);
        }
        return 0;
    }

    detectCurrentIPv4() {
        const interfaces = os.networkInterfaces();
        for (const values of Object.values(interfaces)) {
            if (!Array.isArray(values)) {
                continue;
            }
            for (const item of values) {
                if (!item || item.internal) {
                    continue;
                }
                if (item.family === 'IPv4') {
                    return item.address;
                }
            }
        }
        return '';
    }

    resolveMcpAddHost(hostArg) {
        if (!hostArg) {
            return this.config.mcpDefaultHost;
        }
        const value = String(hostArg).trim();
        if (!value) {
            return '';
        }
        if (value === 'current-ip') {
            return this.detectCurrentIPv4();
        }
        return value;
    }

    printMcpAdd(hostArg) {
        const host = this.resolveMcpAddHost(hostArg);
        if (!host) {
            this.writeStderr('[mcp-add] failed: cannot determine host. Use --host <host> to set one explicitly.');
            return 1;
        }

        const scenes = this.resolveTargets('all');
        for (const sceneName of scenes) {
            const url = `http://${host}:${this.scenePort(sceneName)}/mcp`;
            this.writeStdout(`claude mcp add --transport http playwright-${sceneName} ${url}`);
        }
        this.writeStdout('');
        for (const sceneName of scenes) {
            const url = `http://${host}:${this.scenePort(sceneName)}/mcp`;
            this.writeStdout(`codex mcp add playwright-${sceneName} --url ${url}`);
        }

        return 0;
    }

    printSummary() {
        const scenes = this.resolveTargets('all');
        this.writeStdout(`playwright\truntime=${this.config.runtime}\tscenes=${scenes.join(',')}`);
        return 0;
    }

    async runOnScene(action, sceneName) {
        const def = SCENE_DEFS[sceneName];
        if (action === 'up') {
            return def.type === 'container'
                ? await this.startContainer(sceneName)
                : await this.startHost(sceneName);
        }
        if (action === 'down') {
            return def.type === 'container'
                ? this.stopContainer(sceneName)
                : await this.stopHost(sceneName);
        }
        if (action === 'status') {
            return def.type === 'container'
                ? this.statusContainer(sceneName)
                : await this.statusHost(sceneName);
        }
        if (action === 'health') {
            return await this.healthScene(sceneName);
        }
        if (action === 'logs') {
            return def.type === 'container'
                ? this.logsContainer(sceneName)
                : this.logsHost(sceneName);
        }
        this.writeStderr(`unknown action: ${action}`);
        return 1;
    }

    async run({ action, scene = 'host-headless', host = '' }) {
        if (action === 'ls') {
            return this.printSummary();
        }

        if (action === 'mcp-add') {
            return this.printMcpAdd(host);
        }

        if (!VALID_ACTIONS.has(action)) {
            throw new Error(`未知 plugin 动作: ${action}`);
        }

        const targets = this.resolveTargets(scene);
        if (targets.length === 0) {
            this.writeStderr('没有可执行场景，请检查 runtime 与 enabledScenes 配置');
            return 1;
        }

        let rc = 0;
        for (const sceneName of targets) {
            // eslint-disable-next-line no-await-in-loop
            const code = await this.runOnScene(action, sceneName);
            if (code !== 0) {
                rc = 1;
            }
        }

        return rc;
    }
}

module.exports = {
    SCENE_ORDER,
    SCENE_DEFS,
    PlaywrightPlugin
};
