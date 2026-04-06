'use strict';

const fs = require('fs');
const path = require('path');

function createPlaywrightSceneStateManager(options = {}) {
    const plugin = options.plugin;

    return {
        sceneEndpointPath(sceneName) {
            return path.join(plugin.config.runDir, `${sceneName}.endpoint.json`);
        },
        readSceneEndpoint(sceneName) {
            const filePath = this.sceneEndpointPath(sceneName);
            if (!fs.existsSync(filePath)) {
                return null;
            }
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch {
                return null;
            }
        },
        writeSceneEndpoint(sceneName, payload) {
            fs.mkdirSync(plugin.config.runDir, { recursive: true });
            fs.writeFileSync(this.sceneEndpointPath(sceneName), `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
        },
        removeSceneEndpoint(sceneName) {
            fs.rmSync(this.sceneEndpointPath(sceneName), { force: true });
        },
        sceneCliAttachConfigPath(sceneName) {
            return path.join(plugin.config.runDir, `${sceneName}.cli-attach.json`);
        },
        writeSceneCliAttachConfig(sceneName, payload) {
            fs.mkdirSync(plugin.config.runDir, { recursive: true });
            fs.writeFileSync(this.sceneCliAttachConfigPath(sceneName), `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
        },
        removeSceneCliAttachConfig(sceneName) {
            fs.rmSync(this.sceneCliAttachConfigPath(sceneName), { force: true });
        },
        clearHostSceneRuntimeState(sceneName) {
            this.removeSceneEndpoint(sceneName);
            this.removeSceneCliAttachConfig(sceneName);
        },
        buildCliSessionIntegration(dockerCmd) {
            const sceneName = plugin.config.cliSessionScene;
            if (!sceneName) {
                return { envEntries: [], extraArgs: [], volumeEntries: [] };
            }

            const endpoint = this.readSceneEndpoint(sceneName);
            if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || typeof endpoint.wsPath !== 'string' || !endpoint.wsPath) {
                return { envEntries: [], extraArgs: [], volumeEntries: [] };
            }

            const normalizedDockerCmd = String(dockerCmd || '').trim().toLowerCase();
            const connectHost = normalizedDockerCmd === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
            const remoteEndpoint = `ws://${connectHost}:${endpoint.port}${endpoint.wsPath}`;
            const hostConfigPath = this.sceneCliAttachConfigPath(sceneName);
            const containerConfigPath = `/tmp/manyoyo-playwright/${sceneName}.cli-attach.json`;
            this.writeSceneCliAttachConfig(sceneName, {
                browser: {
                    remoteEndpoint
                }
            });
            const envEntries = [
                `PLAYWRIGHT_MCP_CONFIG=${containerConfigPath}`
            ];
            const extraArgs = normalizedDockerCmd === 'docker'
                ? ['--add-host', 'host.docker.internal:host-gateway']
                : [];
            const volumeEntries = ['--volume', `${hostConfigPath}:${containerConfigPath}:ro`];
            return { envEntries, extraArgs, volumeEntries };
        }
    };
}

module.exports = {
    createPlaywrightSceneStateManager
};
