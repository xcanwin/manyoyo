'use strict';

const os = require('os');

function createPlaywrightCommandOutputManager(options = {}) {
    const plugin = options.plugin;
    const isMcpScene = options.isMcpScene || (() => false);
    const playwrightCliVersion = options.playwrightCliVersion || '';

    return {
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
        },
        resolveMcpAddHost(hostArg) {
            if (!hostArg) {
                return plugin.config.mcpDefaultHost;
            }
            const value = String(hostArg).trim();
            if (!value) {
                return '';
            }
            if (value === 'current-ip') {
                return this.detectCurrentIPv4();
            }
            return value;
        },
        printMcpAdd(hostArg) {
            const host = this.resolveMcpAddHost(hostArg);
            if (!host) {
                plugin.writeStderr('[mcp-add] failed: cannot determine host. Use --host <host> to set one explicitly.');
                return 1;
            }

            const scenes = plugin.resolveTargets('all').filter(sceneName => isMcpScene(sceneName));
            for (const sceneName of scenes) {
                const url = `http://${host}:${plugin.scenePort(sceneName)}/mcp`;
                plugin.writeStdout(`claude mcp add -t http -s user playwright-${sceneName} ${url}`);
            }
            plugin.writeStdout('');
            for (const sceneName of scenes) {
                const url = `http://${host}:${plugin.scenePort(sceneName)}/mcp`;
                plugin.writeStdout(`codex mcp add playwright-${sceneName} --url ${url}`);
            }
            plugin.writeStdout('');
            for (const sceneName of scenes) {
                const url = `http://${host}:${plugin.scenePort(sceneName)}/mcp`;
                plugin.writeStdout(`gemini mcp add -t http -s user playwright-${sceneName} ${url}`);
            }

            return 0;
        },
        printCliAdd() {
            const lines = [
                'PLAYWRIGHT_CLI_INSTALL_DIR="${TMPDIR:-/tmp}/manyoyo-playwright-cli-install-$$"',
                'mkdir -p "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright"',
                'echo \'{"browser":{"browserName":"chromium","launchOptions":{"channel":"chromium"}}}\' > "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright/cli.config.json"',
                'cd "$PLAYWRIGHT_CLI_INSTALL_DIR"',
                `npm install -g @playwright/cli@${playwrightCliVersion}`,
                'playwright-cli install --skills',
                'PLAYWRIGHT_CLI_SKILL_SOURCE="$PLAYWRIGHT_CLI_INSTALL_DIR/.claude/skills/playwright-cli"',
                'for target in ~/.claude/skills/playwright-cli ~/.codex/skills/playwright-cli ~/.gemini/skills/playwright-cli; do',
                '    mkdir -p "$target"',
                '    cp -R "$PLAYWRIGHT_CLI_SKILL_SOURCE/." "$target/"',
                'done',
                'cd "$OLDPWD"',
                'rm -rf "$PLAYWRIGHT_CLI_INSTALL_DIR"'
            ];
            plugin.writeStdout(lines.join('\n'));
            return 0;
        },
        printSummary() {
            const scenes = plugin.resolveTargets('all');
            plugin.writeStdout(`playwright\truntime=${plugin.config.runtime}\tscenes=${scenes.join(',')}`);
            return 0;
        }
    };
}

module.exports = {
    createPlaywrightCommandOutputManager
};
