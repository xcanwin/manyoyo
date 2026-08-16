'use strict';

const { startWebServer } = require('../lib/web/server');

async function main() {
    const port = Number(process.env.MANYOYO_E2E_PORT || 4318);
    const handle = await startWebServer({
        serverHost: '127.0.0.1',
        serverPort: port,
        authUser: 'webadmin',
        authPass: 'topsecret',
        authPassAuto: false,
        dockerCmd: 'docker',
        hostPath: process.cwd(),
        containerPath: '/workspace',
        imageName: 'ghcr.io/xcanwin/manyoyo',
        imageVersion: '1.9.1-common',
        execCommandPrefix: '',
        execCommand: '',
        execCommandSuffix: '',
        contModeArgs: [],
        containerEnvs: [],
        containerVolumes: [],
        validateHostPath: () => {},
        formatDate: () => '0101-0000',
        isValidContainerName: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
        containerExists: () => false,
        getContainerStatus: () => 'running',
        waitForContainerReady: async () => {},
        dockerExecArgs: () => '',
        showImagePullHint: () => {},
        removeContainer: () => {},
        webHistoryDir: '/tmp/manyoyo-e2e-history',
        webConfigPath: '/tmp/manyoyo-e2e-config.json',
        colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
    });
    const close = async () => {
        await handle.close();
        process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
