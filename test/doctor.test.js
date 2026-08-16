'use strict';

const { runDoctorChecks } = require('../lib/doctor');

describe('doctor checks', () => {
    test('reports stable codes for runtime, daemon, image, config, agent, mode and plugin state', () => {
        const report = runDoctorChecks({
            runCommand: (command, args) => {
                if (args[0] === '--version') return `${command} 1.0`;
                if (args[0] === 'info') return 'daemon';
                if (args[0] === 'image') return 'image-id';
                throw new Error('unexpected command');
            },
            configExists: true,
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.9.1-common',
            agentCommand: 'codex exec --skip-git-repo-check {prompt}',
            containerMode: 'sock',
            pluginConfig: { playwright: { runtime: 'host' } },
            portStatus: 'available'
        });

        expect(report.ok).toBe(true);
        expect(report.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'RUNTIME_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'DAEMON_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'IMAGE_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'CONFIG_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'AGENT_CONFIGURED', status: 'ok' }),
            expect.objectContaining({ code: 'MODE_VALID', status: 'ok' }),
            expect.objectContaining({ code: 'PLUGIN_CONFIG_VALID', status: 'ok' }),
            expect.objectContaining({ code: 'PORT_AVAILABLE', status: 'ok' })
        ]));
    });

    test('reports actionable errors without throwing when dependencies are unavailable', () => {
        const report = runDoctorChecks({
            runCommand: () => { throw new Error('not found'); },
            configExists: false,
            imageName: 'image',
            imageVersion: '1.0.0-common',
            agentCommand: '',
            containerMode: 'invalid',
            pluginConfig: [],
            portStatus: 'occupied'
        });

        expect(report.ok).toBe(false);
        expect(report.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE', status: 'error', action: expect.any(String) }),
            expect.objectContaining({ code: 'CONFIG_MISSING', status: 'warning' }),
            expect.objectContaining({ code: 'AGENT_NOT_CONFIGURED', status: 'warning' }),
            expect.objectContaining({ code: 'MODE_INVALID', status: 'error' }),
            expect.objectContaining({ code: 'PLUGIN_CONFIG_INVALID', status: 'warning' }),
            expect.objectContaining({ code: 'PORT_OCCUPIED', status: 'warning' })
        ]));
    });
});
