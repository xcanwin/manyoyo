'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { getAppStatePath, readAppState, launchApp, openBrowser, probeManyoyoServe } = require('../lib/app-launcher');

describe('app launcher', () => {
    let home;
    let statePath;
    let logs;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-app-'));
        statePath = getAppStatePath(home);
        logs = [];
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    // probe 默认沿用 canConnect（真实实现多一步 HTTP 身份探测，单独在下面测）
    const baseDeps = (over = {}) => {
        const deps = baseDeps0(over);
        if (!over.probe) deps.probe = (host, port) => deps.canConnect(host, port);
        return deps;
    };
    const baseDeps0 = (over = {}) => ({
        statePath,
        isProcessRunning: () => false,
        canConnect: async () => true,
        pickPort: async () => 45678,
        spawnServe: jest.fn(() => ({ pid: 4242 })),
        issueToken: () => 't'.repeat(64),
        open: jest.fn(() => true),
        log: line => logs.push(line),
        sleep: async () => {},
        ...over
    });

    test('starts a new loopback serve, records app.json (0600) and opens the tokenized url', async () => {
        const deps = baseDeps();
        const result = await launchApp(deps);

        expect(deps.spawnServe).toHaveBeenCalledWith(45678);
        expect(result).toEqual(expect.objectContaining({ reused: false, opened: true, pid: 4242 }));
        expect(deps.open).toHaveBeenCalledWith(`http://127.0.0.1:45678/auth/login?token=${'t'.repeat(64)}`);
        expect(readAppState(statePath)).toEqual(expect.objectContaining({ host: '127.0.0.1', port: 45678, pid: 4242 }));
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
        expect(logs.join('\n')).toContain('http://127.0.0.1:45678');
        expect(logs.join('\n')).not.toContain('token=');
        expect(logs.join('\n')).toContain('关闭服务: manyoyo serve 127.0.0.1:45678 --stop');
    });

    test('reuses a live instance without spawning', async () => {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ host: '127.0.0.1', port: 3111, pid: 99 }));
        const deps = baseDeps({ isProcessRunning: pid => pid === 99 });
        const result = await launchApp(deps);

        expect(deps.spawnServe).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ reused: true, baseUrl: 'http://127.0.0.1:3111' }));
        expect(deps.open.mock.calls[0][0]).toContain('http://127.0.0.1:3111/auth/login?token=');
    });

    test.each([
        ['dead process', { isProcessRunning: () => false }],
        ['closed port', { isProcessRunning: () => true, canConnect: jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true) }]
    ])('starts fresh when the recorded instance is stale (%s)', async (_name, over) => {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ host: '127.0.0.1', port: 3111, pid: 99 }));
        const deps = baseDeps(over);
        const result = await launchApp(deps);
        expect(deps.spawnServe).toHaveBeenCalledTimes(1);
        expect(result.reused).toBe(false);
    });

    test('ignores a corrupt or foreign app.json', async () => {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, '{not json');
        expect(readAppState(statePath)).toBeNull();
        fs.writeFileSync(statePath, JSON.stringify({ host: '0.0.0.0', port: 1, pid: 2 }));
        expect(readAppState(statePath)).toBeNull();
    });

    test('prints the address once when no browser opener exists', async () => {
        const deps = baseDeps({ open: jest.fn(() => false) });
        const result = await launchApp(deps);
        expect(result.opened).toBe(false);
        expect(logs.join('\n')).toContain(`http://127.0.0.1:45678/auth/login?token=${'t'.repeat(64)}`);
    });

    test('throws with a log hint when the new serve never becomes ready', async () => {
        let clock = 0;
        const deps = baseDeps({
            canConnect: async () => false,
            now: () => clock,
            sleep: async ms => { clock += ms; },
            readyTimeoutMs: 1000,
            logPathHint: '/logs/serve.log'
        });
        await expect(launchApp(deps)).rejects.toThrow(/未就绪.*\/logs\/serve\.log/);
        expect(deps.open).not.toHaveBeenCalled();
    });

    test('openBrowser picks the opener by platform', () => {
        const run = jest.fn(() => ({ status: 0 }));
        expect(openBrowser('http://x', { platform: 'darwin', run })).toBe(true);
        expect(run).toHaveBeenLastCalledWith('open', ['http://x']);
        expect(openBrowser('http://x', { platform: 'linux', run })).toBe(true);
        expect(run).toHaveBeenLastCalledWith('xdg-open', ['http://x']);
        expect(openBrowser('http://x', { platform: 'win32', run })).toBe(false);
        expect(openBrowser('http://x', { platform: 'linux', run: () => ({ error: new Error('ENOENT') }) })).toBe(false);
    });

    test('two launchers at once start exactly one serve; the second reuses it', async () => {
        const alive = pid => pid === process.pid || pid === 4242;
        const slow = ms => new Promise(resolve => setTimeout(resolve, ms));
        const spawnServe = jest.fn(() => ({ pid: 4242 }));
        const mk = () => baseDeps({ isProcessRunning: alive, spawnServe, pickPort: async () => { await slow(50); return 45678; }, sleep: () => slow(10) });
        const [a, b] = await Promise.all([launchApp(mk()), launchApp(mk())]);
        expect(spawnServe).toHaveBeenCalledTimes(1);
        expect([a.reused, b.reused].sort()).toEqual([false, true]);
        expect(fs.existsSync(path.join(path.dirname(statePath), 'app.lock'))).toBe(false);
    });

    test('a lock left behind by a dead launcher is cleared', async () => {
        const lock = path.join(path.dirname(statePath), 'app.lock');
        fs.mkdirSync(lock, { recursive: true });
        fs.writeFileSync(path.join(lock, 'pid'), '999999\n');
        const deps = baseDeps({ isProcessRunning: () => false });
        const result = await launchApp(deps);
        expect(result.reused).toBe(false);
        expect(fs.existsSync(lock)).toBe(false);
    });

    test('does not reuse (and never sends a token to) a port that is not manyoyo serve', async () => {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ host: '127.0.0.1', port: 3111, pid: 99 }));
        const probe = jest.fn(async (host, port) => port !== 3111);
        const deps = baseDeps({ isProcessRunning: pid => pid === 99, probe });
        const result = await launchApp(deps);
        expect(result.reused).toBe(false);
        expect(deps.spawnServe).toHaveBeenCalledWith(45678);
        expect(deps.open.mock.calls[0][0]).toContain(':45678/');
    });

    test('reports a spawn failure instead of waiting for the full timeout', async () => {
        const spawnServe = jest.fn(() => ({
            pid: undefined,
            on: (event, handler) => { if (event === 'error') setImmediate(() => handler(new Error('spawn ENOENT'))); }
        }));
        await expect(launchApp(baseDeps({ spawnServe, logPathHint: '/logs/serve.log' }))).rejects.toThrow(/无法启动本机服务.*ENOENT/);
        expect(fs.existsSync(path.join(path.dirname(statePath), 'app.lock'))).toBe(false);
    });

    test('retries once with a new port when serve exits right away (port taken between pick and bind)', async () => {
        const ports = [45001, 45002];
        const spawnServe = jest.fn(port => ({
            pid: 4000 + (port % 10),
            on: (event, handler) => { if (event === 'exit' && port === 45001) setImmediate(() => handler(1)); }
        }));
        const probe = jest.fn(async (host, port) => port === 45002);
        const result = await launchApp(baseDeps({ spawnServe, probe, pickPort: async () => ports.shift(), sleep: () => new Promise(resolve => setTimeout(resolve, 5)) }));
        expect(spawnServe).toHaveBeenCalledTimes(2);
        expect(result.baseUrl).toBe('http://127.0.0.1:45002');
    });

    describe('probeManyoyoServe', () => {
        const listen = handler => new Promise(resolve => {
            const server = http.createServer(handler);
            server.listen(0, '127.0.0.1', () => resolve(server));
        });

        test('true only when the response carries the manyoyo marker (even a 401)', async () => {
            const mine = await listen((req, res) => { res.setHeader('X-Manyoyo-Serve', '1'); res.writeHead(401); res.end('{}'); });
            const foreign = await listen((req, res) => { res.writeHead(200); res.end('hi'); });
            try {
                expect(await probeManyoyoServe('127.0.0.1', mine.address().port)).toBe(true);
                expect(await probeManyoyoServe('127.0.0.1', foreign.address().port)).toBe(false);
            } finally {
                mine.close();
                foreign.close();
            }
            expect(await probeManyoyoServe('127.0.0.1', 1)).toBe(false);
        });
    });
});
