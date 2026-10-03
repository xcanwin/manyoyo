'use strict';

const { runDoctorChecks, applyDoctorFixes } = require('../lib/doctor');

describe('doctor checks', () => {
    const podmanRun = ({ exe = '', runError = null } = {}) => (command, args) => {
        const text = args.join(' ');
        if (text === '--version') return 'podman version 4.9.3';
        if (text.includes('Rootless')) return 'true';
        if (text.includes('Executable')) return exe;
        if (args[0] === 'info') return 'daemon';
        if (args[0] === 'image') return 'image-id';
        if (args[0] === 'run') { if (runError) throw runError; return ''; }
        throw new Error('unexpected command');
    };
    const podmanOptions = runCommand => ({
        selectRuntime: () => ({ command: 'podman', env: {}, source: 'podman-daemon' }),
        runCommand, platform: 'linux', configExists: true, imageName: 'img', imageVersion: '1-common', agentCommand: 'claude', portStatus: 'available'
    });

    test('missing rootless network component is an error with the fix command, and skips the start test', async () => {
        const calls = [];
        const run = podmanRun();
        const report = await runDoctorChecks(podmanOptions((c, a) => { calls.push(a[0]); return run(c, a); }));
        const check = report.checks.find(item => item.code === 'ROOTLESS_NETWORK_MISSING');
        expect(check).toEqual(expect.objectContaining({ status: 'error', action: expect.stringMatching(/install -y slirp4netns|slirp4netns/) }));
        expect(report.ok).toBe(false);
        expect(calls).not.toContain('run');
    });

    test('healthy rootless podman: network ok and a real container start passes', async () => {
        const report = await runDoctorChecks(podmanOptions(podmanRun({ exe: '/usr/bin/slirp4netns' })));
        expect(report.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'ROOTLESS_NETWORK_OK', status: 'ok' }),
            expect.objectContaining({ code: 'CONTAINER_START_OK', status: 'ok' })
        ]));
        expect(report.ok).toBe(true);
    });

    test('a failing real start is translated by error hints', async () => {
        const error = Object.assign(new Error('Command failed'), { stderr: 'Error: Bind for 0.0.0.0:80 failed: port is already allocated' });
        const report = await runDoctorChecks(podmanOptions(podmanRun({ exe: '/x', runError: error })));
        expect(report.checks.find(item => item.code === 'CONTAINER_START_FAILED')).toEqual(expect.objectContaining({ status: 'error', summary: expect.stringContaining('端口') }));
    });

    test('no plugins configured is not a warning', async () => {
        const report = await runDoctorChecks(podmanOptions(podmanRun({ exe: '/x' })));
        expect(report.checks.find(item => item.code === 'PLUGIN_CONFIG_VALID')).toEqual(expect.objectContaining({ status: 'ok' }));
        expect(report.checks.find(item => item.code === 'PLUGIN_CONFIG_INVALID')).toBeUndefined();
    });

    test('reports stable codes for runtime, daemon, image, config, agent, mode and plugin state', async () => {
        const report = await runDoctorChecks({
            selectRuntime: () => ({ command: 'docker', env: {}, source: 'docker-daemon' }),
            runCommand: (command, args) => {
                if (args[0] === '--version') return `${command} 1.0`;
                if (args[0] === 'info') return 'daemon';
                if (args[0] === 'image') return 'image-id';
                if (args[0] === 'run') return '';
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
        expect(report.runtimeCommand).toBe('docker');
        expect(report.runtimeSource).toBe('docker-daemon');
        expect(report.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'RUNTIME_AVAILABLE', status: 'ok', summary: expect.stringContaining('docker-daemon') }),
            expect.objectContaining({ code: 'DAEMON_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'IMAGE_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'CONFIG_AVAILABLE', status: 'ok' }),
            expect.objectContaining({ code: 'AGENT_CONFIGURED', status: 'ok' }),
            expect.objectContaining({ code: 'MODE_VALID', status: 'ok' }),
            expect.objectContaining({ code: 'PLUGIN_CONFIG_VALID', status: 'ok' }),
            expect.objectContaining({ code: 'PORT_AVAILABLE', status: 'ok' })
        ]));
    });

    test('reports actionable errors without throwing when dependencies are unavailable', async () => {
        const report = await runDoctorChecks({
            selectRuntime: () => { throw new Error('not found'); },
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

    test('accepts an async command runner', async () => {
        const report = await runDoctorChecks({
            selectRuntime: () => ({ command: 'docker', env: {}, source: 'config' }),
            runCommand: async () => { await new Promise(resolve => setImmediate(resolve)); return 'ok'; },
            configExists: true, imageName: 'i', imageVersion: '1.0.0-common'
        });
        expect(report.checks.find(c => c.code === 'DAEMON_AVAILABLE').status).toBe('ok');
    });

    test('passes the selected runtime env and a timeout to every runtime command', async () => {
        const seen = [];
        await runDoctorChecks({
            selectRuntime: () => ({ command: '/p/podman', env: { CONTAINERS_CONF: '/p/c.conf' }, source: 'private-podman' }),
            runCommand: (command, args, options) => {
                seen.push({ command, env: options && options.env, timeout: options && options.timeout });
                return 'ok';
            },
            imageName: 'image',
            imageVersion: '1.0.0-common'
        });

        expect(seen.length).toBeGreaterThanOrEqual(3);
        seen.forEach(call => {
            expect(call.command).toBe('/p/podman');
            expect(call.env).toEqual({ CONTAINERS_CONF: '/p/c.conf' });
            expect(call.timeout).toBeGreaterThan(0);
        });
    });
});

describe('doctor --fix', () => {
    const brokenReport = async () => runDoctorChecks({
        selectRuntime: () => ({ command: 'docker', env: {}, source: 'docker-daemon' }),
        runCommand: (command, args) => {
            if (args[0] === '--version') return 'v';
            throw new Error('boom');
        },
        configExists: false,
        imageName: 'img',
        imageVersion: '1.0.0-common',
        agentCommand: 'claude',
        containerMode: 'common',
        pluginConfig: {},
        portStatus: 'occupied'
    });

    test('fixes daemon, image and config, and only suggests a port', async () => {
        const order = [];
        const fixed = await applyDoctorFixes(await brokenReport(), {
            startRuntime: async () => { order.push('runtime'); return { fixed: true, message: '已启动' }; },
            pullImage: async () => { order.push('image'); return { fixed: true, message: '已拉取' }; },
            createConfig: () => { order.push('config'); return { fixed: true, message: '已生成' }; },
            suggestPort: () => { order.push('port'); return { fixed: false, message: '建议使用端口 3001' }; }
        });
        const fixOf = code => fixed.checks.find(c => c.code === code).fix;

        expect(order).toEqual(['runtime', 'image', 'config', 'port']);
        expect(fixOf('DAEMON_UNAVAILABLE')).toEqual({ attempted: true, fixed: true, message: '已启动' });
        expect(fixOf('IMAGE_MISSING').fixed).toBe(true);
        expect(fixOf('CONFIG_MISSING').fixed).toBe(true);
        expect(fixOf('PORT_OCCUPIED')).toEqual({ attempted: true, fixed: false, message: '建议使用端口 3001' });
        expect(fixed.ok).toBe(true);
    });

    test('skips the image pull when the runtime could not be repaired', async () => {
        const pullImage = jest.fn();
        const fixed = await applyDoctorFixes(await brokenReport(), {
            startRuntime: async () => ({ fixed: false, message: '超时' }),
            pullImage
        });
        expect(pullImage).not.toHaveBeenCalled();
        expect(fixed.checks.find(c => c.code === 'IMAGE_MISSING').fix.attempted).toBe(false);
        expect(fixed.ok).toBe(false);
    });

    test('a throwing handler is reported instead of crashing, and missing handlers mean not attempted', async () => {
        const fixed = await applyDoctorFixes(await brokenReport(), {
            startRuntime: () => { throw new Error('nope\ndetail'); }
        });
        expect(fixed.checks.find(c => c.code === 'DAEMON_UNAVAILABLE').fix).toEqual({ attempted: true, fixed: false, message: 'nope' });
        expect(fixed.checks.find(c => c.code === 'CONFIG_MISSING').fix).toEqual({ attempted: false, fixed: false, message: '' });
    });

    test('healthy checks carry no fix field', async () => {
        const report = await runDoctorChecks({
            selectRuntime: () => ({ command: 'docker', env: {}, source: 'config' }),
            runCommand: () => 'ok',
            configExists: true,
            imageName: 'i',
            imageVersion: '1.0.0-common',
            agentCommand: 'claude',
            containerMode: 'common',
            pluginConfig: {},
            portStatus: 'available'
        });
        const fixed = await applyDoctorFixes(report, {});
        expect(fixed.checks.every(c => c.fix === undefined)).toBe(true);
    });
});
