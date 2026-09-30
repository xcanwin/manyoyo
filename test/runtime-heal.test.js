'use strict';

const { ensureRuntimeReady } = require('../lib/runtime-heal');

// script: 按顺序描述每次 info 的结果；其余命令记录到 calls
function makeHarness({ infoResults = [], machines, startFails = false, openFails = false }) {
    const calls = [];
    let infoIndex = 0;
    const run = (command, args, opts) => {
        calls.push({ command, args, opts });
        if (args[0] === 'info') {
            const ok = infoResults[Math.min(infoIndex, infoResults.length - 1)];
            infoIndex += 1;
            if (!ok) throw new Error('info failed');
            return 'ok';
        }
        if (args[0] === 'machine' && args[1] === 'list') {
            if (machines === undefined) throw new Error('no machine subcommand');
            return JSON.stringify(machines);
        }
        if (args[0] === 'machine' && args[1] === 'start') {
            if (startFails) throw new Error('start failed\nmore');
            return '';
        }
        if (command === 'open') {
            if (openFails) throw new Error('open failed');
            return '';
        }
        throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    let clock = 0;
    const statuses = [];
    return {
        calls,
        statuses,
        options: {
            run,
            sleep: async ms => { clock += ms; },
            now: () => clock,
            onStatus: state => statuses.push(state),
            timeoutMs: 10000,
            pollMs: 2000
        }
    };
}

describe('ensureRuntimeReady', () => {
    test('returns ready without touching anything when info works', async () => {
        const h = makeHarness({ infoResults: [true] });
        const result = await ensureRuntimeReady({ ...h.options, runtime: { command: 'docker', env: {} } });
        expect(result.status).toBe('ready');
        expect(h.calls).toHaveLength(1);
        expect(h.statuses).toEqual([]);
    });

    test('starts a stopped podman machine and waits until info works', async () => {
        const h = makeHarness({
            infoResults: [false, false, true],
            machines: [{ Name: 'podman-machine-default*', Default: true, Running: false }]
        });
        const env = { CONTAINERS_CONF: '/x' };
        const result = await ensureRuntimeReady({ ...h.options, runtime: { command: '/p/bin/podman', env } });

        expect(result.status).toBe('started');
        const start = h.calls.find(c => c.args[0] === 'machine' && c.args[1] === 'start');
        expect(start.args).toEqual(['machine', 'start', 'podman-machine-default']);
        expect(start.opts.env).toEqual(env);
        expect(h.statuses.map(s => s.status)).toEqual(['starting', 'ready']);
        expect(h.statuses[0].message).toContain('正在启动容器环境');
    });

    test('reports failure when podman machine start fails', async () => {
        const h = makeHarness({
            infoResults: [false],
            machines: [{ Name: 'm', Default: true, Running: false }],
            startFails: true
        });
        const result = await ensureRuntimeReady({ ...h.options, runtime: { command: 'podman' } });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('podman machine start 失败: start failed');
        expect(h.statuses[h.statuses.length - 1].status).toBe('failed');
    });

    test('does not guess when there is no podman machine or it already runs', async () => {
        const none = makeHarness({ infoResults: [false], machines: [] });
        expect((await ensureRuntimeReady({ ...none.options, runtime: { command: 'podman' } })).message)
            .toContain('podman machine init');

        const running = makeHarness({ infoResults: [false], machines: [{ Name: 'm', Running: true }] });
        const result = await ensureRuntimeReady({ ...running.options, runtime: { command: 'podman' } });
        expect(result.status).toBe('unavailable');
        expect(running.calls.some(c => c.args[1] === 'start')).toBe(false);
    });

    test('opens Docker Desktop on darwin and waits', async () => {
        const h = makeHarness({ infoResults: [false, false, true] });
        const result = await ensureRuntimeReady({ ...h.options, platform: 'darwin', runtime: { command: 'docker' } });
        expect(result.status).toBe('started');
        expect(h.calls.find(c => c.command === 'open').args).toEqual(['-a', 'Docker']);
    });

    test('times out when Docker Desktop never becomes ready', async () => {
        const h = makeHarness({ infoResults: [false] });
        const result = await ensureRuntimeReady({ ...h.options, platform: 'darwin', runtime: { command: 'docker' } });
        expect(result.status).toBe('timeout');
        expect(result.message).toContain('超时');
        expect(h.statuses[h.statuses.length - 1].status).toBe('failed');
    });

    test('reports failed when open -a Docker itself fails', async () => {
        const h = makeHarness({ infoResults: [false], openFails: true });
        const result = await ensureRuntimeReady({ ...h.options, platform: 'darwin', runtime: { command: 'docker' } });
        expect(result.status).toBe('failed');
    });

    test('docker on linux is only reported, never launched', async () => {
        const h = makeHarness({ infoResults: [false] });
        const result = await ensureRuntimeReady({ ...h.options, platform: 'linux', runtime: { command: 'docker' } });
        expect(result.status).toBe('unavailable');
        expect(h.calls.some(c => c.command === 'open')).toBe(false);
    });
});
