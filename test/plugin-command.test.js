const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaywrightPlugin, EXTENSIONS } = require('../lib/plugin/playwright');
const { playwrightCliVersion: PACKAGE_PLAYWRIGHT_CLI_VERSION } = require('../package.json');

const BIN_PATH = path.join(__dirname, '../bin/manyoyo.js');

function withTempHome(configObj, runner) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-plugin-'));
    const configDir = path.join(tempHome, '.manyoyo');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'manyoyo.json'),
        `${JSON.stringify(configObj, null, 4)}\n`,
        'utf8'
    );

    try {
        return runner(tempHome);
    } finally {
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
}

describe('manyoyo plugin commands', () => {
    test('playwright mcp-add prints scene endpoints', () => {
        const output = execSync(`node ${BIN_PATH} playwright mcp-add --host localhost`, { encoding: 'utf-8' });
        expect(output).toContain('http://localhost:8931/mcp');
        expect(output).toContain('http://localhost:8932/mcp');
        expect(output).toContain('http://localhost:8933/mcp');
        expect(output).toContain('http://localhost:8934/mcp');
        expect(output).not.toContain('cli-host-headless');
    });

    test('plugin playwright mcp-add supports namespace form', () => {
        const output = execSync(`node ${BIN_PATH} plugin playwright mcp-add --host localhost`, { encoding: 'utf-8' });
        expect(output).toContain('playwright-mcp-cont-headless');
        expect(output).toContain('playwright-mcp-host-headed');
    });

    test('playwright cli-add prints playwright-cli skill install commands', () => {
        const output = execSync(`node ${BIN_PATH} playwright cli-add`, { encoding: 'utf-8' });
        expect(output).toContain('echo \'{"browser":{"browserName":"chromium","launchOptions":{"channel":"chromium"}}}\' > "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright/cli.config.json"');
        expect(output).toContain(`npm install -g @playwright/cli@${PACKAGE_PLAYWRIGHT_CLI_VERSION}`);
        expect(output).toContain('playwright-cli install --skills');
        expect(output).toContain('"channel":"chromium"');
        expect(output).toContain('~/.codex/skills/playwright-cli');
        expect(output).toContain('~/.gemini/skills/playwright-cli');
    });

    test('plugin playwright cli-add supports namespace form', () => {
        const output = execSync(`node ${BIN_PATH} plugin playwright cli-add`, { encoding: 'utf-8' });
        expect(output).toContain('playwright-cli install --skills');
        expect(output).toContain('~/.codex/skills/playwright-cli');
    });

    test('playwright mcp-add respects run profile plugins.playwright.runtime', () => {
        withTempHome({
            runs: {
                onlyContainer: {
                    plugins: {
                        playwright: {
                            runtime: 'container'
                        }
                    }
                }
            }
        }, (tempHome) => {
            const output = execSync(`node ${BIN_PATH} playwright mcp-add -r onlyContainer --host localhost`, {
                encoding: 'utf-8',
                env: { ...process.env, HOME: tempHome }
            });

            expect(output).toContain('playwright-mcp-cont-headless');
            expect(output).toContain('playwright-mcp-cont-headed');
            expect(output).not.toContain('playwright-mcp-host-headless');
            expect(output).not.toContain('playwright-mcp-host-headed');
        });
    });

    test('plugin unknown name should fail', () => {
        expect(() => {
            execSync(`node ${BIN_PATH} plugin unknown up`, {
                encoding: 'utf-8',
                stdio: 'pipe'
            });
        }).toThrow();
    });

    test('playwright ext-download command exists and removes old options', () => {
        const output = execSync(`node ${BIN_PATH} playwright ext-download --help`, { encoding: 'utf-8' });
        expect(output).toContain('ext-download');
        expect(output).toContain('--prodversion');
        expect(output).not.toContain('--clean-tmp');
        expect(output).not.toContain('--run');
    });

    test('playwright help no longer lists ext-sync', () => {
        const output = execSync(`node ${BIN_PATH} playwright --help`, { encoding: 'utf-8' });
        expect(output).toContain('cli-add');
        expect(output).toContain('ext-download');
        expect(output).not.toContain('ext-sync');
    });

    test('playwright up supports --ext-path and --ext-name options', () => {
        const output = execSync(`node ${BIN_PATH} playwright up --help`, { encoding: 'utf-8' });
        expect(output).toContain('--ext-path');
        expect(output).toContain('--ext-name');
        expect(output).not.toContain('--ext <path>');
    });

    test('playwright help examples use prefixed mcp scenes', () => {
        const output = execSync(`node ${BIN_PATH} --help`, { encoding: 'utf-8' });
        expect(output).toContain('playwright up mcp-host-headless');
        expect(output).toContain('playwright up cli-host-headless');
        expect(output).not.toContain('plugin playwright up mcp-host-headless');
        expect(output).not.toContain('playwright up host-headless');
    });
});

describe('PlaywrightPlugin runtime filtering', () => {
    test('container runtime should auto-detect docker first', () => {
        const ensureCommandSpy = jest.spyOn(PlaywrightPlugin.prototype, 'ensureCommandAvailable')
            .mockImplementation((command) => command === 'docker');

        try {
            const plugin = new PlaywrightPlugin();
            expect(plugin.config.containerRuntime).toBe('docker');
        } finally {
            ensureCommandSpy.mockRestore();
        }
    });

    test('container runtime should fallback to podman when docker is unavailable', () => {
        const ensureCommandSpy = jest.spyOn(PlaywrightPlugin.prototype, 'ensureCommandAvailable')
            .mockImplementation((command) => command === 'podman');

        try {
            const plugin = new PlaywrightPlugin();
            expect(plugin.config.containerRuntime).toBe('podman');
        } finally {
            ensureCommandSpy.mockRestore();
        }
    });

    test('container runtime should respect explicit config', () => {
        const ensureCommandSpy = jest.spyOn(PlaywrightPlugin.prototype, 'ensureCommandAvailable')
            .mockImplementation(() => false);

        try {
            const plugin = new PlaywrightPlugin({
                globalConfig: {
                    containerRuntime: 'podman'
                }
            });
            expect(plugin.config.containerRuntime).toBe('podman');
        } finally {
            ensureCommandSpy.mockRestore();
        }
    });

    test('runtime host only returns host scenes', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'host'
            }
        });

        expect(plugin.resolveTargets('all')).toEqual(['mcp-host-headless', 'mcp-host-headed', 'cli-host-headless', 'cli-host-headed']);
    });

    test('enabled scenes works with runtime mixed', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'mixed',
                enabledScenes: ['mcp-cont-headless', 'cli-host-headed']
            }
        });

        expect(plugin.resolveTargets('all')).toEqual(['mcp-cont-headless', 'cli-host-headed']);
    });

    test('cont-headed non-up env should not require vnc password', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'container'
            }
        });
        const env = plugin.containerEnv('mcp-cont-headed', '/tmp/playwright.json');
        expect(typeof env.VNC_PASSWORD).toBe('string');
        expect(env.VNC_PASSWORD.length).toBeGreaterThan(0);
    });

    test('cont-headed up env should auto-generate 16-char password when env is missing', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'container'
            }
        });
        const env = plugin.containerEnv('mcp-cont-headed', '/tmp/playwright.json', { requireVncPassword: true });

        expect(typeof env.VNC_PASSWORD).toBe('string');
        expect(env.VNC_PASSWORD).toMatch(/^[A-Za-z0-9]{16}$/);
    });

    test('mcp-host-headless scene config should include anti-detection baseline', () => {
        const plugin = new PlaywrightPlugin();
        const cfg = plugin.buildSceneConfig('mcp-host-headless');
        const launchArgs = (((cfg || {}).browser || {}).launchOptions || {}).args || [];
        const contextOptions = (((cfg || {}).browser || {}).contextOptions || {});

        expect(Array.isArray(launchArgs)).toBe(true);
        expect(launchArgs).toContain('--disable-blink-features=AutomationControlled');
        expect(launchArgs).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
        expect(launchArgs).toContain('--lang=zh-CN');
        expect(launchArgs).toContain('--window-size=1366,768');
        expect(launchArgs.find(arg => arg.startsWith('--user-agent='))).toBeTruthy();

        expect(contextOptions.userAgent).toContain('Chrome/');
        expect(contextOptions.locale).toBe('zh-CN');
        expect(contextOptions.timezoneId).toBe('Asia/Shanghai');
        expect(contextOptions.viewport).toEqual({ width: 1366, height: 768 });
        expect(contextOptions.screen).toEqual({ width: 1366, height: 768 });
        expect(contextOptions.extraHTTPHeaders).toEqual({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
    });

    test('ensureSceneConfig should inject init script for navigator.platform alignment', () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-init-script-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-init-script-run-'));
        try {
            const plugin = new PlaywrightPlugin({
                globalConfig: {
                    configDir: tempConfigDir,
                    runDir: tempRunDir
                }
            });
            const cfgPath = plugin.ensureSceneConfig('mcp-host-headless');
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const initScripts = cfg.browser && cfg.browser.initScript;
            const initScriptPath = Array.isArray(initScripts) ? initScripts[0] : '';
            const initScriptContent = fs.readFileSync(initScriptPath, 'utf8');

            expect(Array.isArray(initScripts)).toBe(true);
            expect(fs.existsSync(initScriptPath)).toBe(true);
            expect(initScriptContent).toContain("Object.defineProperty(navProto, 'platform'");
            expect(initScriptContent).toContain('MacIntel');
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('disableWebRTC should append launch arg and disable script block', () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-webrtc-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-webrtc-run-'));
        try {
            const plugin = new PlaywrightPlugin({
                globalConfig: {
                    configDir: tempConfigDir,
                    runDir: tempRunDir,
                    disableWebRTC: true
                }
            });
            const cfgPath = plugin.ensureSceneConfig('mcp-host-headless');
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            const launchArgs = (((cfg || {}).browser || {}).launchOptions || {}).args || [];
            const initScripts = cfg.browser && cfg.browser.initScript;
            const initScriptPath = Array.isArray(initScripts) ? initScripts[0] : '';
            const initScriptContent = fs.readFileSync(initScriptPath, 'utf8');

            expect(launchArgs).toContain('--disable-webrtc');
            expect(initScriptContent).toContain('RTCPeerConnection');
            expect(initScriptContent).toContain('getUserMedia');
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('any scene can inject extension args via buildSceneConfig options', () => {
        const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-'));
        for (const [name] of EXTENSIONS) {
            fs.mkdirSync(path.join(extRoot, name), { recursive: true });
        }

        try {
            const plugin = new PlaywrightPlugin();
            const extensionPaths = EXTENSIONS.map(([name]) => path.join(extRoot, name));
            const cfg = plugin.buildSceneConfig('mcp-cont-headless', { extensionPaths });
            const launchArgs = cfg.browser && cfg.browser.launchOptions && cfg.browser.launchOptions.args;

            expect(Array.isArray(launchArgs)).toBe(true);
            const disableExtensionsArg = launchArgs.find(arg => arg.startsWith('--disable-extensions-except='));
            const loadExtensionsArg = launchArgs.find(arg => arg.startsWith('--load-extension='));
            expect(disableExtensionsArg).toBeTruthy();
            expect(loadExtensionsArg).toBeTruthy();
            expect(disableExtensionsArg).toContain(path.join(extRoot, EXTENSIONS[0][0]));
        } finally {
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });

    test('resolveExtensionInputs merges extension path and extension name', () => {
        const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-inputs-'));
        const extPath = path.join(extRoot, 'from-path');
        const extNameRoot = path.join(extRoot, 'names-root');
        const extName = 'adguard';
        const extNamePath = path.join(extNameRoot, extName);
        fs.mkdirSync(extPath, { recursive: true });
        fs.mkdirSync(extNamePath, { recursive: true });
        fs.writeFileSync(path.join(extPath, 'manifest.json'), '{"manifest_version":3}', 'utf8');
        fs.writeFileSync(path.join(extNamePath, 'manifest.json'), '{"manifest_version":3}', 'utf8');

        try {
            const plugin = new PlaywrightPlugin();
            plugin.extensionDirPath = () => extNameRoot;
            const extensionPaths = plugin.resolveExtensionInputs({
                extensionPaths: [extPath],
                extensionNames: [extName]
            });
            const cfg = plugin.buildSceneConfig('mcp-host-headless', { extensionPaths });
            const launchArgs = cfg.browser && cfg.browser.launchOptions && cfg.browser.launchOptions.args;

            expect(Array.isArray(launchArgs)).toBe(true);
            const disableExtensionsArg = launchArgs.find(arg => arg.startsWith('--disable-extensions-except='));
            const loadExtensionsArg = launchArgs.find(arg => arg.startsWith('--load-extension='));
            expect(disableExtensionsArg).toBeTruthy();
            expect(loadExtensionsArg).toBeTruthy();
            expect(disableExtensionsArg).toContain(extPath);
            expect(disableExtensionsArg).toContain(extNamePath);
        } finally {
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });

    test('playwright default runtime paths use plugin directory', () => {
        const plugin = new PlaywrightPlugin();
        expect(plugin.config.configDir).toContain(path.join('.manyoyo', 'plugin', 'playwright', 'config'));
        expect(plugin.config.runDir).toContain(path.join('.manyoyo', 'plugin', 'playwright', 'run'));
    });

    test('container extension paths are mapped to in-container mount targets', () => {
        const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-mount-'));
        const extA = path.join(extRoot, 'a');
        const extB = path.join(extRoot, 'b');
        fs.mkdirSync(extA, { recursive: true });
        fs.mkdirSync(extB, { recursive: true });
        fs.writeFileSync(path.join(extA, 'manifest.json'), '{"manifest_version":3}', 'utf8');
        fs.writeFileSync(path.join(extB, 'manifest.json'), '{"manifest_version":3}', 'utf8');

        try {
            const plugin = new PlaywrightPlugin();
            const mapped = plugin.buildContainerExtensionMounts([extA, extB]);
            expect(mapped.containerPaths[0]).toContain('/app/extensions/ext-1-');
            expect(mapped.containerPaths[1]).toContain('/app/extensions/ext-2-');
            expect(mapped.volumeMounts[0]).toBe(`${extA}:${mapped.containerPaths[0]}:ro`);
            expect(mapped.volumeMounts[1]).toBe(`${extB}:${mapped.containerPaths[1]}:ro`);
        } finally {
            fs.rmSync(extRoot, { recursive: true, force: true });
        }
    });

    test('container compose override file is generated and removable', () => {
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-compose-override-'));
        try {
            const plugin = new PlaywrightPlugin({
                globalConfig: {
                    runDir: tempRunDir
                }
            });
            const mounts = ['/tmp/ext-a:/app/extensions/ext-1-a:ro'];
            const overridePath = plugin.ensureContainerComposeOverride('mcp-cont-headless', mounts);
            const content = fs.readFileSync(overridePath, 'utf8');

            expect(content).toContain('services:');
            expect(content).toContain('playwright:');
            expect(content).toContain('/tmp/ext-a:/app/extensions/ext-1-a:ro');

            plugin.ensureContainerComposeOverride('mcp-cont-headless', []);
            expect(fs.existsSync(overridePath)).toBe(false);
        } finally {
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli session integration should build docker attach config from cli host endpoint', () => {
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-cli-endpoint-'));
        try {
            const plugin = new PlaywrightPlugin({
                globalConfig: {
                    runDir: tempRunDir
                }
            });
            fs.writeFileSync(plugin.sceneEndpointPath('cli-host-headless'), `${JSON.stringify({
                port: 8935,
                wsPath: '/manyoyo-test'
            }, null, 4)}\n`, 'utf8');

            const integration = plugin.buildCliSessionIntegration('docker');
            expect(integration.envEntries).toContain('PLAYWRIGHT_MCP_CONFIG=/tmp/manyoyo-playwright/cli-host-headless.cli-attach.json');
            expect(integration.extraArgs).toEqual(['--add-host', 'host.docker.internal:host-gateway']);
            expect(integration.volumeEntries).toEqual([
                '--volume',
                `${plugin.sceneCliAttachConfigPath('cli-host-headless')}:/tmp/manyoyo-playwright/cli-host-headless.cli-attach.json:ro`
            ]);
            const attachConfig = JSON.parse(fs.readFileSync(plugin.sceneCliAttachConfigPath('cli-host-headless'), 'utf8'));
            expect(attachConfig).toEqual({
                browser: {
                    remoteEndpoint: 'ws://host.docker.internal:8935/manyoyo-test'
                }
            });
        } finally {
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli scene should prefer playwright binary bundled with @playwright/mcp', () => {
        const plugin = new PlaywrightPlugin();
        expect(plugin.playwrightBinPath('cli-host-headless')).toContain(path.join('@playwright', 'mcp', 'node_modules', '.bin', 'playwright'));
    });
});

describe('PlaywrightPlugin first-run bootstrap', () => {
    test('container scene pulls base image when scene config is missing', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'container',
                containerRuntime: 'docker',
                dockerTag: '1.2.3'
            }
        });

        const commands = [];
        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.waitForPort = jest.fn(async () => true);

        try {
            const rc = await plugin.startContainer('mcp-cont-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['docker', 'pull', 'mcr.microsoft.com/playwright/mcp:1.2.3']);
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('container scene config should use in-container initScript path and mount init script file', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'container',
                containerRuntime: 'docker',
                dockerTag: '1.2.3'
            }
        });

        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn(() => ({ returncode: 0, stdout: '', stderr: '' }));
        plugin.waitForPort = jest.fn(async () => true);

        try {
            const rc = await plugin.startContainer('mcp-cont-headless');
            expect(rc).toBe(0);

            const cfg = JSON.parse(fs.readFileSync(plugin.sceneConfigPath('mcp-cont-headless'), 'utf8'));
            expect(cfg.browser.initScript).toEqual(['/app/config/mcp-cont-headless.init.js']);

            const overridePath = plugin.sceneComposeOverridePath('mcp-cont-headless');
            const overrideContent = fs.readFileSync(overridePath, 'utf8');
            expect(overrideContent).toContain('/app/config/mcp-cont-headless.init.js');
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('container scene does not pull image when scene config exists', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'container',
                containerRuntime: 'docker',
                dockerTag: '1.2.3'
            }
        });

        const cfgPath = plugin.sceneConfigPath('mcp-cont-headless');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, '{"server":{}}\n', 'utf8');

        const commands = [];
        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.waitForPort = jest.fn(async () => true);

        try {
            const rc = await plugin.startContainer('mcp-cont-headless');
            expect(rc).toBe(0);
            expect(commands.find(args => args[0] === 'docker' && args[1] === 'pull')).toBeUndefined();
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('host scene installs default browser when scene config is missing', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host'
            }
        });

        const commands = [];
        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.localBinPath = jest.fn((name) => `/mock/bin/${name}`);
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('mcp-host-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['/mock/bin/playwright', 'install', '--with-deps', 'chromium']);
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('host scene does not install browser when scene config exists', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host'
            }
        });

        const cfgPath = plugin.sceneConfigPath('mcp-host-headless');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, '{"server":{}}\n', 'utf8');

        const commands = [];
        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.localBinPath = jest.fn((name) => `/mock/bin/${name}`);
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('mcp-host-headless');
            expect(rc).toBe(0);
            const installCmd = commands.find(args => args[0] === '/mock/bin/playwright' && args[1] === 'install');
            expect(installCmd).toBeUndefined();
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli host scene still installs browser when scene config exists', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host'
            }
        });

        const cfgPath = plugin.sceneConfigPath('cli-host-headless');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, '{"host":"0.0.0.0"}\n', 'utf8');

        const commands = [];
        plugin.ensureCommandAvailable = jest.fn(() => true);
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.playwrightBinPath = jest.fn(() => '/mock/bin/playwright-cli-host');
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('cli-host-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['/mock/bin/playwright-cli-host', 'install', '--with-deps', 'chromium']);
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli host scene should write endpoint metadata after start', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host'
            }
        });

        const commands = [];
        plugin.runCmd = jest.fn((args) => {
            commands.push(args);
            return { returncode: 0, stdout: '', stderr: '' };
        });
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.localBinPath = jest.fn((name) => `/mock/bin/${name}`);
        plugin.playwrightBinPath = jest.fn(() => '/mock/bin/playwright-cli-host');
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('cli-host-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['/mock/bin/playwright-cli-host', 'install', '--with-deps', 'chromium']);

            const endpoint = JSON.parse(fs.readFileSync(plugin.sceneEndpointPath('cli-host-headless'), 'utf8'));
            expect(endpoint.port).toBe(8935);
            expect(endpoint.wsPath.startsWith('/')).toBe(true);
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli-host-headed should remind cliSessionScene when config is not aligned', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const stdout = { write: jest.fn() };
        const plugin = new PlaywrightPlugin({
            stdout,
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host',
                cliSessionScene: 'cli-host-headless'
            }
        });

        plugin.runCmd = jest.fn(() => ({ returncode: 0, stdout: '', stderr: '' }));
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.localBinPath = jest.fn((name) => `/mock/bin/${name}`);
        plugin.playwrightBinPath = jest.fn(() => '/mock/bin/playwright-cli-host');
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('cli-host-headed');
            expect(rc).toBe(0);
            const output = stdout.write.mock.calls.map(args => args[0]).join('');
            expect(output).toContain('[tip] 如果希望容器内 manyoyo run 自动附着到当前 CLI 宿主场景');
            expect(output).toContain('"cliSessionScene": "cli-host-headed"');
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('cli-host-headed should not remind cliSessionScene when config already aligned', async () => {
        const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-config-'));
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const stdout = { write: jest.fn() };
        const plugin = new PlaywrightPlugin({
            stdout,
            globalConfig: {
                configDir: tempConfigDir,
                runDir: tempRunDir,
                runtime: 'host',
                cliSessionScene: 'cli-host-headed'
            }
        });

        plugin.runCmd = jest.fn(() => ({ returncode: 0, stdout: '', stderr: '' }));
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);
        plugin.waitForPort = jest.fn(async () => true);
        plugin.waitForHostPids = jest.fn(async () => [12345]);
        plugin.localBinPath = jest.fn((name) => `/mock/bin/${name}`);
        plugin.playwrightBinPath = jest.fn(() => '/mock/bin/playwright-cli-host');
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('cli-host-headed');
            expect(rc).toBe(0);
            const output = stdout.write.mock.calls.map(args => args[0]).join('');
            expect(output).not.toContain('[tip] 如果希望容器内 manyoyo run 自动附着到当前 CLI 宿主场景');
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });

    test('stopHost should remove cli attach config artifact', async () => {
        const tempRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-playwright-run-'));
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runDir: tempRunDir,
                runtime: 'host'
            }
        });

        fs.writeFileSync(plugin.sceneEndpointPath('cli-host-headless'), '{"port":8935,"wsPath":"/x"}\n', 'utf8');
        fs.writeFileSync(plugin.sceneCliAttachConfigPath('cli-host-headless'), '{"browser":{"remoteEndpoint":"ws://host.docker.internal:8935/x"}}\n', 'utf8');
        plugin.hostScenePids = jest.fn(() => []);
        plugin.portReady = jest.fn(async () => false);

        try {
            const rc = await plugin.stopHost('cli-host-headless');
            expect(rc).toBe(0);
            expect(fs.existsSync(plugin.sceneEndpointPath('cli-host-headless'))).toBe(false);
            expect(fs.existsSync(plugin.sceneCliAttachConfigPath('cli-host-headless'))).toBe(false);
        } finally {
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });
});
