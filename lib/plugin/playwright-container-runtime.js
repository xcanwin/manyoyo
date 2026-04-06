'use strict';

const fs = require('fs');
const path = require('path');

function createPlaywrightContainerRuntimeManager(options = {}) {
    const plugin = options.plugin;
    const sceneDefs = options.sceneDefs || {};

    return {
        containerEnv(sceneName, cfgPath, actionOptions = {}) {
            const def = sceneDefs[sceneName];
            const requireVncPassword = actionOptions.requireVncPassword === true;
            const env = {
                ...process.env,
                PLAYWRIGHT_MCP_DOCKER_TAG: plugin.config.dockerTag,
                PLAYWRIGHT_MCP_PORT: String(plugin.scenePort(sceneName)),
                PLAYWRIGHT_MCP_CONFIG_PATH: cfgPath,
                PLAYWRIGHT_MCP_CONTAINER_NAME: def.containerName,
                PLAYWRIGHT_MCP_IMAGE: plugin.config.headedImage,
                PLAYWRIGHT_MCP_NOVNC_PORT: String(plugin.config.ports.mcpContHeadedNoVnc)
            };

            if (sceneName === 'mcp-cont-headed') {
                const envKey = plugin.config.vncPasswordEnvKey;
                let password = process.env[envKey];
                if (!password) {
                    password = plugin.randomAlnum(16);
                    if (requireVncPassword) {
                        plugin.writeStdout(`[up] mcp-cont-headed ${envKey} not set; generated random 16-char password: ${password}`);
                    }
                }
                env.VNC_PASSWORD = password;
            }

            return env;
        },
        containerComposePath(sceneName) {
            const def = sceneDefs[sceneName];
            return path.join(plugin.config.composeDir, def.composeFile);
        },
        sceneComposeOverridePath(sceneName) {
            return path.join(plugin.config.runDir, `${sceneName}.compose.override.yaml`);
        },
        ensureContainerComposeOverride(sceneName, volumeMounts = []) {
            const overridePath = this.sceneComposeOverridePath(sceneName);
            if (!Array.isArray(volumeMounts) || volumeMounts.length === 0) {
                fs.rmSync(overridePath, { force: true });
                return '';
            }

            fs.mkdirSync(plugin.config.runDir, { recursive: true });
            const lines = [
                'services:',
                '  playwright:',
                '    volumes:'
            ];
            volumeMounts.forEach(item => {
                lines.push(`      - ${JSON.stringify(String(item))}`);
            });
            fs.writeFileSync(overridePath, `${lines.join('\n')}\n`, 'utf8');
            return overridePath;
        },
        ensureContainerRuntimeAvailable(action, sceneName) {
            const runtime = plugin.config.containerRuntime;
            if (!plugin.ensureCommandAvailable(runtime)) {
                plugin.writeStderr(`[${action}] ${sceneName} failed: ${runtime} command not found.`);
                return '';
            }
            return runtime;
        },
        buildContainerComposeCommand(sceneName, composeFiles = [], trailingArgs = []) {
            const def = sceneDefs[sceneName];
            const files = Array.isArray(composeFiles) && composeFiles.length > 0
                ? composeFiles
                : [this.containerComposePath(sceneName)];
            const args = [
                plugin.config.containerRuntime,
                'compose',
                '-p',
                def.projectName
            ];
            files.forEach(filePath => {
                args.push('-f', filePath);
            });
            args.push(...trailingArgs);
            return args;
        }
    };
}

module.exports = {
    createPlaywrightContainerRuntimeManager
};
