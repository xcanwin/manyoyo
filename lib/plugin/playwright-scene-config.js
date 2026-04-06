'use strict';

const fs = require('fs');
const crypto = require('crypto');

function createPlaywrightSceneConfigManager(options = {}) {
    const plugin = options.plugin;
    const sceneDefs = options.sceneDefs || {};
    const isCliScene = options.isCliScene || (() => false);
    const asStringArray = options.asStringArray || ((value, fallback) => fallback);
    const defaultFingerprintProfile = options.defaultFingerprintProfile || {};
    const disableWebRtcLaunchArgs = options.disableWebRtcLaunchArgs || [];

    return {
        buildExtensionLaunchArgs(extensionPaths) {
            const joined = extensionPaths.join(',');
            return [
                `--disable-extensions-except=${joined}`,
                `--load-extension=${joined}`
            ];
        },
        baseLaunchArgs() {
            return [
                `--user-agent=${defaultFingerprintProfile.userAgent}`,
                `--lang=${defaultFingerprintProfile.locale}`,
                `--window-size=${defaultFingerprintProfile.width},${defaultFingerprintProfile.height}`,
                '--disable-blink-features=AutomationControlled',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
            ];
        },
        buildSceneLaunchArgs(extensionPaths = []) {
            const args = [...this.baseLaunchArgs()];
            if (Array.isArray(extensionPaths) && extensionPaths.length > 0) {
                args.push(...this.buildExtensionLaunchArgs(extensionPaths));
            }
            if (plugin.config.disableWebRTC) {
                args.push(...disableWebRtcLaunchArgs);
            }
            return args;
        },
        buildMcpSceneConfig(sceneName, actionOptions = {}) {
            const def = sceneDefs[sceneName];
            const port = plugin.scenePort(sceneName);
            const extensionPaths = asStringArray(actionOptions.extensionPaths, []);
            const initScript = asStringArray(actionOptions.initScript, []);
            const launchOptions = {
                channel: 'chromium',
                headless: def.headless,
                args: this.buildSceneLaunchArgs(extensionPaths)
            };

            const contextOptions = {
                userAgent: defaultFingerprintProfile.userAgent,
                locale: defaultFingerprintProfile.locale,
                timezoneId: defaultFingerprintProfile.timezoneId,
                extraHTTPHeaders: {
                    'Accept-Language': defaultFingerprintProfile.acceptLanguage
                }
            };
            if (sceneName !== 'mcp-host-headed') {
                contextOptions.viewport = {
                    width: defaultFingerprintProfile.width,
                    height: defaultFingerprintProfile.height
                };
                contextOptions.screen = {
                    width: defaultFingerprintProfile.width,
                    height: defaultFingerprintProfile.height
                };
            }

            return {
                outputDir: '/tmp/.playwright-mcp',
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
                    initScript,
                    launchOptions,
                    contextOptions
                }
            };
        },
        buildCliSceneConfig(sceneName, actionOptions = {}) {
            const def = sceneDefs[sceneName];
            const extensionPaths = asStringArray(actionOptions.extensionPaths, []);
            return {
                host: def.listenHost,
                port: plugin.scenePort(sceneName),
                wsPath: `/${sceneName}-${crypto.randomBytes(8).toString('hex')}`,
                headless: def.headless,
                channel: 'chromium',
                chromiumSandbox: true,
                args: this.buildSceneLaunchArgs(extensionPaths)
            };
        },
        buildSceneConfig(sceneName, actionOptions = {}) {
            if (isCliScene(sceneName)) {
                return this.buildCliSceneConfig(sceneName, actionOptions);
            }
            return this.buildMcpSceneConfig(sceneName, actionOptions);
        },
        writeSceneConfigFile(sceneName, payload) {
            const filePath = plugin.sceneConfigPath(sceneName);
            fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
            return filePath;
        },
        ensureSceneConfig(sceneName, actionOptions = {}) {
            fs.mkdirSync(plugin.config.configDir, { recursive: true });
            let payload = null;
            if (isCliScene(sceneName)) {
                payload = this.buildCliSceneConfig(sceneName, actionOptions);
            } else {
                const initScriptPath = plugin.ensureSceneInitScript(sceneName);
                const configuredInitScript = asStringArray(actionOptions.initScript, []);
                const initScript = configuredInitScript.length > 0 ? configuredInitScript : [initScriptPath];
                payload = this.buildSceneConfig(sceneName, {
                    ...actionOptions,
                    initScript
                });
            }
            return this.writeSceneConfigFile(sceneName, payload);
        }
    };
}

module.exports = {
    createPlaywrightSceneConfigManager
};
