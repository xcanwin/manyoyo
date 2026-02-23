const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaywrightPlugin } = require('../lib/services/playwright');

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
});
