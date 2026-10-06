'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sidecar = require('../lib/egress-sidecar');

describe('egress-sidecar 纯函数', () => {
    test('chooseSidecarIp：/24 取 .250 附近的保留地址；不同 HOME 错开；网段太小报错', () => {
        const ips = new Set();
        ['/h/a', '/h/b', '/h/c', '/h/d', '/h/e', '/h/f'].forEach(home => {
            const ip = sidecar.chooseSidecarIp('10.89.0.0/24', home);
            expect(ip).toMatch(/^10\.89\.0\.(24[6-9]|250)$/);
            ips.add(ip);
        });
        expect(ips.size).toBeGreaterThan(1);
        expect(sidecar.chooseSidecarIp('10.89.0.0/24', '/h/a')).toBe(sidecar.chooseSidecarIp('10.89.0.0/24', '/h/a'));
        expect(sidecar.chooseSidecarIp('172.20.0.0/16', '/h/a')).toMatch(/^172\.20\.0\.(24[6-9]|250)$/);
        expect(() => sidecar.chooseSidecarIp('10.89.0.0/30', '/h/a')).toThrow();
        expect(() => sidecar.chooseSidecarIp('', '/h/a')).toThrow();
    });

    test('macForIp：与 docker 的 02:42:<IP> 规则一致', () => {
        expect(sidecar.macForIp('10.89.0.250')).toBe('02:42:0a:59:00:fa');
    });

    test('subnetOfNetwork：podman 与 docker 两种 inspect 格式', () => {
        expect(sidecar.subnetOfNetwork([{ subnets: [{ subnet: '10.89.0.0/24', gateway: '10.89.0.1' }] }])).toBe('10.89.0.0/24');
        expect(sidecar.subnetOfNetwork({ IPAM: { Config: [{ Subnet: '172.18.0.0/16' }] } })).toBe('172.18.0.0/16');
        expect(sidecar.subnetOfNetwork({ IPAM: { Config: [{ Subnet: 'fd00::/64' }, { Subnet: '172.18.0.0/16' }] } })).toBe('172.18.0.0/16');
        expect(sidecar.subnetOfNetwork({})).toBe('');
    });

    test('containerSideUpstream：环回地址改成容器看到的宿主机别名，其他原样；非 http 忽略', () => {
        expect(sidecar.containerSideUpstream('http://127.0.0.1:7890', 'host.containers.internal')).toBe('http://host.containers.internal:7890');
        expect(sidecar.containerSideUpstream('http://u:p@localhost:7890', 'host.docker.internal')).toBe('http://u:p@host.docker.internal:7890');
        expect(sidecar.containerSideUpstream('http://172.16.99.1:10808', 'h')).toBe('http://172.16.99.1:10808');
        expect(sidecar.containerSideUpstream('socks5://127.0.0.1:1080', 'h')).toBe('');
        expect(sidecar.containerSideUpstream('', 'h')).toBe('');
    });

    test('isSidecarName：只认 manyoyo-egress-<8 位十六进制>', () => {
        expect(sidecar.isSidecarName(sidecar.sidecarName('/a'))).toBe(true);
        ['manyoyo-egress', 'manyoyo-egress-xyz12345', 'my-easy-1', 'manyoyo-egress-0123456789'].forEach(n => expect(sidecar.isSidecarName(n)).toBe(false));
    });

    test('sidecarName 随 HOME 变化，且只含合法字符', () => {
        expect(sidecar.sidecarName('/a')).toMatch(/^manyoyo-egress-[0-9a-f]{8}$/);
        expect(sidecar.sidecarName('/a')).not.toBe(sidecar.sidecarName('/b'));
    });

    test('sidecar 里要用的文件都存在且互相只依赖这几个文件和 node 内置模块', () => {
        const builtin = new Set(require('module').builtinModules);
        sidecar.APP_FILES.forEach(file => {
            const text = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf-8');
            [...text.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).forEach(dep => {
                if (dep.startsWith('./')) expect(sidecar.APP_FILES).toContain(`${dep.slice(2)}.js`);
                else expect(builtin.has(dep.replace(/^node:/, ''))).toBe(true);
            });
        });
    });
});

describe('createSidecarManager（假运行时）', () => {
    let home;
    let calls;
    let containers;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
        calls = [];
        containers = new Map();
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    function fakeRun(args) {
        calls.push(args);
        const [cmd] = args;
        const name = sidecar.sidecarName(home);
        if (cmd === 'network') return Promise.resolve(JSON.stringify({ subnets: [{ subnet: '10.89.0.0/24' }] }));
        if (cmd === 'inspect') {
            const c = containers.get(args[args.length - 1]);
            if (!c) return Promise.reject(new Error(`Error: no such object: "${name}"`));
            return Promise.resolve(JSON.stringify(c));
        }
        if (cmd === 'run') {
            const labels = {};
            args.forEach((a, i) => { if (a === '--label') { const [k, v] = args[i + 1].split('='); labels[k] = v; } });
            containers.set(name, { State: { Running: true }, Config: { Labels: labels }, NetworkSettings: { Networks: { manyoyo: { IPAddress: args[args.indexOf('--ip') + 1] } } } });
            return Promise.resolve('id');
        }
        if (cmd === 'logs') return Promise.resolve('egress-proxy ready 3128\n');
        if (cmd === 'exec') return Promise.resolve('');
        if (cmd === 'rm') { containers.delete(name); return Promise.resolve(''); }
        if (cmd === 'start') { containers.get(name).State.Running = true; return Promise.resolve(''); }
        return Promise.resolve('');
    }
    const make = (upstream = '') => sidecar.createSidecarManager({ run: fakeRun, command: 'podman', homeDir: home, imageRef: () => 'img:1', networkName: 'manyoyo', ensureNetwork: async () => {}, getUpstream: () => upstream });

    test('不存在就创建：只读挂载程序与数据、丢掉全部能力、固定 IP；再次调用不重复创建', async () => {
        const mgr = make();
        const info = await mgr.ensure();
        expect(info).toEqual({ name: sidecar.sidecarName(home), ip: expect.stringMatching(/^10\.89\.0\.\d+$/), port: 3128 });
        const run = calls.find(a => a[0] === 'run');
        const p = mgr.paths();
        expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--ip', info.ip, '--mac-address', sidecar.macForIp(info.ip), '--entrypoint', 'node', `${p.app}:/app:ro`, `${p.data}:/data:ro`, `${p.denied}:/denied`]));
        expect(run.join(' ')).not.toMatch(/--publish|-p /);
        expect(run.slice(-2)).toEqual(['img:1', '/app/egress-sidecar-main.js']);
        await mgr.ensure();
        expect(calls.filter(a => a[0] === 'run').length).toBe(1);
        APP_FILES_PRESENT(p.app);
    });

    test('已停止就 start；被删或配置（上游）变了就重建；上游写进 0600 文件而不是 env / 参数', async () => {
        const mgr = make();
        await mgr.ensure();
        containers.get(sidecar.sidecarName(home)).State.Running = false;
        await mgr.ensure();
        expect(calls.some(a => a[0] === 'start')).toBe(true);
        expect(calls.filter(a => a[0] === 'run').length).toBe(1);

        const mgr2 = make('http://127.0.0.1:7890');
        await mgr2.ensure();
        expect(calls.filter(a => a[0] === 'run').length).toBe(2);
        expect(calls.some(a => a[0] === 'rm')).toBe(true);
        const upstreamFile = path.join(mgr2.paths().data, 'upstream.txt');
        expect(fs.readFileSync(upstreamFile, 'utf-8').trim()).toBe('http://host.containers.internal:7890');
        expect(fs.statSync(upstreamFile).mode & 0o777).toBe(0o600);
        expect(calls.filter(a => a[0] === 'run').pop().join(' ')).not.toContain('7890');
    });

    test('writeClients 原子写入映射，内容不变不重写', () => {
        const mgr = make();
        mgr.writeClients({ '10.89.0.7': { id: 'aaaaaaaaaaaaaaaa', preset: 'allowlist', domains: ['a.com'], rules: [] } });
        const file = path.join(mgr.paths().data, 'clients.json');
        expect(JSON.parse(fs.readFileSync(file, 'utf-8')).clients['10.89.0.7'].id).toBe('aaaaaaaaaaaaaaaa');
        const mtime = fs.statSync(file).mtimeMs;
        mgr.writeClients({ '10.89.0.7': { id: 'aaaaaaaaaaaaaaaa', preset: 'allowlist', domains: ['a.com'], rules: [] } });
        expect(fs.statSync(file).mtimeMs).toBe(mtime);
        expect(fs.readdirSync(mgr.paths().data).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });
});

function APP_FILES_PRESENT(appDir) {
    sidecar.APP_FILES.forEach(file => expect(fs.existsSync(path.join(appDir, file))).toBe(true));
}
