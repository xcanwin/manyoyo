const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaywrightPlugin, EXTENSIONS } = require('../lib/plugin/playwright');

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
    });

    test('plugin playwright mcp-add supports namespace form', () => {
        const output = execSync(`node ${BIN_PATH} plugin playwright mcp-add --host localhost`, { encoding: 'utf-8' });
        expect(output).toContain('playwright-cont-headless');
        expect(output).toContain('playwright-host-headed');
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

            expect(output).toContain('playwright-cont-headless');
            expect(output).toContain('playwright-cont-headed');
            expect(output).not.toContain('playwright-host-headless');
            expect(output).not.toContain('playwright-host-headed');
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
        expect(output).toContain('ext-download');
        expect(output).not.toContain('ext-sync');
    });

    test('playwright up supports --ext-path and --ext-name options', () => {
        const output = execSync(`node ${BIN_PATH} playwright up --help`, { encoding: 'utf-8' });
        expect(output).toContain('--ext-path');
        expect(output).toContain('--ext-name');
        expect(output).not.toContain('--ext <path>');
    });
});

describe('PlaywrightPlugin runtime filtering', () => {
    test('runtime host only returns host scenes', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'host'
            }
        });

        expect(plugin.resolveTargets('all')).toEqual(['host-headless', 'host-headed']);
    });

    test('enabled scenes works with runtime mixed', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'mixed',
                enabledScenes: ['cont-headless', 'host-headed']
            }
        });

        expect(plugin.resolveTargets('all')).toEqual(['cont-headless', 'host-headed']);
    });

    test('cont-headed non-up env should not require vnc password', () => {
        const plugin = new PlaywrightPlugin({
            globalConfig: {
                runtime: 'container'
            }
        });
        const env = plugin.containerEnv('cont-headed', '/tmp/playwright.json');
        expect(typeof env.VNC_PASSWORD).toBe('string');
        expect(env.VNC_PASSWORD.length).toBeGreaterThan(0);
    });

    test('any scene can inject extension args via buildSceneConfig options', () => {
        const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-'));
        for (const [name] of EXTENSIONS) {
            fs.mkdirSync(path.join(extRoot, name), { recursive: true });
        }

        try {
            const plugin = new PlaywrightPlugin();
            const extensionPaths = EXTENSIONS.map(([name]) => path.join(extRoot, name));
            const cfg = plugin.buildSceneConfig('cont-headless', { extensionPaths });
            const launchArgs = cfg.browser && cfg.browser.launchOptions && cfg.browser.launchOptions.args;

            expect(Array.isArray(launchArgs)).toBe(true);
            expect(launchArgs[0]).toContain('--disable-extensions-except=');
            expect(launchArgs[1]).toContain('--load-extension=');
            expect(launchArgs[0]).toContain(path.join(extRoot, EXTENSIONS[0][0]));
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
            const cfg = plugin.buildSceneConfig('host-headless', { extensionPaths });
            const launchArgs = cfg.browser && cfg.browser.launchOptions && cfg.browser.launchOptions.args;

            expect(Array.isArray(launchArgs)).toBe(true);
            expect(launchArgs[0]).toContain('--disable-extensions-except=');
            expect(launchArgs[1]).toContain('--load-extension=');
            expect(launchArgs[0]).toContain(extPath);
            expect(launchArgs[0]).toContain(extNamePath);
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
            const overridePath = plugin.ensureContainerComposeOverride('cont-headless', mounts);
            const content = fs.readFileSync(overridePath, 'utf8');

            expect(content).toContain('services:');
            expect(content).toContain('playwright:');
            expect(content).toContain('/tmp/ext-a:/app/extensions/ext-1-a:ro');

            plugin.ensureContainerComposeOverride('cont-headless', []);
            expect(fs.existsSync(overridePath)).toBe(false);
        } finally {
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
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
            const rc = await plugin.startContainer('cont-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['docker', 'pull', 'mcr.microsoft.com/playwright/mcp:1.2.3']);
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

        const cfgPath = plugin.sceneConfigPath('cont-headless');
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
            const rc = await plugin.startContainer('cont-headless');
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
                runtime: 'host',
                npmVersion: 'latest'
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
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('host-headless');
            expect(rc).toBe(0);
            expect(commands[0]).toEqual(['npx', '-y', 'playwright-core', 'install', 'chromium']);
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
                runtime: 'host',
                npmVersion: 'latest'
            }
        });

        const cfgPath = plugin.sceneConfigPath('host-headless');
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
        plugin.spawnHostProcess = jest.fn(() => ({ pid: 12345, unref() {}, exitCode: null, killed: false }));

        try {
            const rc = await plugin.startHost('host-headless');
            expect(rc).toBe(0);
            const installCmd = commands.find(args => args[0] === 'npx' && args[2] === 'playwright-core');
            expect(installCmd).toBeUndefined();
        } finally {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
            fs.rmSync(tempRunDir, { recursive: true, force: true });
        }
    });
});
