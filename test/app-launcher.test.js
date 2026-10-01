'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAppStatePath, readAppState, launchApp, openBrowser } = require('../lib/app-launcher');

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

    const baseDeps = (over = {}) => ({
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
});
