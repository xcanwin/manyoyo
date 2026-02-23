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

    test('playwright ext-sync command exists', () => {
        const output = execSync(`node ${BIN_PATH} playwright ext-sync --help`, { encoding: 'utf-8' });
        expect(output).toContain('ext-sync');
        expect(output).toContain('--clean-tmp');
    });

    test('playwright up supports --ext option', () => {
        const output = execSync(`node ${BIN_PATH} playwright up --help`, { encoding: 'utf-8' });
        expect(output).toContain('--ext');
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

    test('playwright default runtime paths use plugin directory', () => {
        const plugin = new PlaywrightPlugin();
        expect(plugin.config.configDir).toContain(path.join('.manyoyo', 'plugin', 'playwright', 'config'));
        expect(plugin.config.runDir).toContain(path.join('.manyoyo', 'plugin', 'playwright', 'run'));
    });
});
