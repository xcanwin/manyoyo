const {
    handleDoctorRequest,
    handleMetaAgentsRequest
} = require('../lib/web/controllers/system');

describe('Web system controllers', () => {
    test('agent metadata controller delegates to the adapter registry', async () => {
        const sendJson = jest.fn();
        await handleMetaAgentsRequest({}, { sendJson, listAgentMetadata: () => [{ id: 'codex' }] });
        expect(sendJson).toHaveBeenCalledWith({}, 200, { agents: [{ id: 'codex' }] });
    });

    test('doctor controller passes web runtime and config snapshot to the shared check service', async () => {
        const sendJson = jest.fn();
        const runDoctorChecks = jest.fn(() => ({ ok: true, checks: [] }));
        const dockerExecArgs = jest.fn(() => 'ok');
        const ctx = {
            dockerCmd: 'docker',
            dockerExecArgs,
            imageName: 'ghcr.io/xcanwin/manyoyo',
            imageVersion: '1.9.1-common',
            execCommandPrefix: '',
            execCommand: 'codex',
            execCommandSuffix: ''
        };

        await handleDoctorRequest({}, ctx, { webConfigPath: '/tmp/manyoyo.json' }, {
            sendJson,
            readWebConfigSnapshot: () => ({ exists: true, parseError: null, parsed: { plugins: { playwright: {} } } }),
            buildDefaultCommand: () => 'codex',
            runDoctorChecks
        });

        expect(runDoctorChecks).toHaveBeenCalledWith(expect.objectContaining({
            runtimeCandidates: ['docker'],
            configExists: true,
            agentCommand: 'codex',
            pluginConfig: { playwright: {} }
        }));
        const options = runDoctorChecks.mock.calls[0][0];
        expect(options.runCommand('docker', ['info'])).toBe('ok');
        expect(dockerExecArgs).toHaveBeenCalledWith(['info'], { stdio: 'pipe' });
        expect(sendJson).toHaveBeenCalledWith({}, 200, { ok: true, checks: [] });
    });
});
