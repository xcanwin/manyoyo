'use strict';

const fs = require('fs');
const path = require('path');

function createPlaywrightBootstrapManager(options = {}) {
    const plugin = options.plugin;
    const isCliScene = options.isCliScene || (() => false);

    return {
        buildInitScriptContent() {
            const lines = [
                "'use strict';",
                '(function () {',
                `    const platformValue = ${JSON.stringify(plugin.config.navigatorPlatform)};`,
                '    try {',
                '        const navProto = Object.getPrototypeOf(navigator);',
                "        Object.defineProperty(navProto, 'platform', {",
                '            configurable: true,',
                '            get: () => platformValue',
                '        });',
                '    } catch (_) {}'
            ];

            if (plugin.config.disableWebRTC) {
                lines.push(
                    '    try {',
                    '        const scope = globalThis;',
                    "        const blocked = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDataChannel'];",
                    '        for (const name of blocked) {',
                    "            Object.defineProperty(scope, name, { configurable: true, writable: true, value: undefined });",
                    '        }',
                    '        if (navigator.mediaDevices) {',
                    '            const errorFactory = () => {',
                    '                try {',
                    "                    return new DOMException('WebRTC is disabled', 'NotAllowedError');",
                    '                } catch (_) {',
                    "                    const error = new Error('WebRTC is disabled');",
                    "                    error.name = 'NotAllowedError';",
                    '                    return error;',
                    '                }',
                    '            };',
                    "            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {",
                    '                configurable: true,',
                    '                writable: true,',
                    '                value: async () => { throw errorFactory(); }',
                    '            });',
                    '        }',
                    '    } catch (_) {}'
                );
            }

            lines.push('})();', '');
            return lines.join('\n');
        },
        ensureSceneInitScript(sceneName) {
            const filePath = plugin.sceneInitScriptPath(sceneName);
            const content = this.buildInitScriptContent();
            fs.writeFileSync(filePath, content, 'utf8');
            return filePath;
        },
        defaultBrowserName(sceneName) {
            if (isCliScene(sceneName)) {
                return 'chromium';
            }
            const cfg = plugin.buildSceneConfig(sceneName);
            const browserName = cfg && cfg.browser && cfg.browser.browserName;
            return String(browserName || 'chromium');
        },
        ensureContainerScenePrerequisites(sceneName) {
            if (!plugin.sceneConfigMissing(sceneName)) {
                return;
            }
            const tag = String(plugin.config.dockerTag || 'latest').trim() || 'latest';
            const image = `mcr.microsoft.com/playwright/mcp:${tag}`;
            plugin.runCmd([plugin.config.containerRuntime, 'pull', image], { check: true });
        },
        ensureHostScenePrerequisites(sceneName) {
            if (!isCliScene(sceneName) && !plugin.sceneConfigMissing(sceneName)) {
                return;
            }
            plugin.runCmd([this.playwrightBinPath(sceneName), 'install', '--with-deps', this.defaultBrowserName(sceneName)], { check: true });
        },
        localBinPath(binName) {
            const filename = process.platform === 'win32' ? `${binName}.cmd` : binName;
            const binPath = path.join(plugin.projectRoot, 'node_modules', '.bin', filename);
            if (!fs.existsSync(binPath)) {
                throw new Error(`local binary not found: ${binPath}. Run npm install first.`);
            }
            return binPath;
        },
        playwrightBinPath(sceneName) {
            if (!isCliScene(sceneName)) {
                return this.localBinPath('playwright');
            }

            const filename = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
            const candidates = [
                path.join(plugin.projectRoot, 'node_modules', '@playwright', 'mcp', 'node_modules', '.bin', filename),
                path.join(plugin.projectRoot, 'node_modules', '.bin', filename)
            ];

            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }

            throw new Error(`local binary not found for ${sceneName}. Run npm install first.`);
        }
    };
}

module.exports = {
    createPlaywrightBootstrapManager
};
