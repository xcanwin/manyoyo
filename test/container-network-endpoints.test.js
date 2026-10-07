'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNetworkManager } = require('../lib/container-network');
const { normalizePolicy } = require('../lib/network-policy');

// 假运行时：一次性 helper 容器读到的 hosts / resolv.conf
function makeManager(hostsText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-endpoints-'));
    const fake = path.join(dir, 'fake-docker.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ncat <<'EOF_HOSTS'\n${hostsText}\nEOF_HOSTS\n`, { mode: 0o755 });
    const manager = createNetworkManager({ command: fake, homeDir: dir, imageRef: () => 'img:1', warn: () => {} });
    return { manager, dir };
}

describe('resolveEndpoints：运行时注入的宿主机代理', () => {
    test('代理指向 host.containers.internal 时放行容器看到的宿主机 IP（不在宿主机上解析）', async () => {
        const { manager, dir } = makeManager('10.88.0.1 host.containers.internal\nnameserver 10.88.0.1');
        try {
            const self = { id: '0123456789abcdef', name: 'c', running: true, info: { Config: { Env: ['https_proxy=http://host.containers.internal:10808'] } } };
            const endpoints = await manager.resolveEndpoints(self, normalizePolicy(), [self]);
            expect(endpoints.allow).toEqual(expect.arrayContaining([{ ip: '10.88.0.1', ports: '10808', proto: 'tcp' }]));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('代理指向 127.0.0.1 时同样放行宿主机 IP 的该端口', async () => {
        const { manager, dir } = makeManager('10.88.0.1 host.containers.internal\nnameserver 10.88.0.1');
        try {
            const self = { id: '0123456789abcdef', name: 'c', running: true, info: { Config: { Env: ['HTTP_PROXY=http://127.0.0.1:7890'] } } };
            const endpoints = await manager.resolveEndpoints(self, normalizePolicy(), [self]);
            expect(endpoints.allow).toEqual(expect.arrayContaining([{ ip: '10.88.0.1', ports: '7890', proto: 'tcp' }]));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('容器间规则：派生行与相关容器', () => {
    const ID_A = 'aaaaaaaaaaaaaaaa';
    const ID_B = 'bbbbbbbbbbbbbbbb';
    const state = require('../lib/container-state');

    function info(id, ip) {
        return {
            Name: `/${id === ID_A ? 'boxa' : 'boxb'}`,
            State: { Running: true },
            Config: { Labels: { 'manyoyo.id': id }, Env: [] },
            NetworkSettings: { Networks: { manyoyo: { IPAddress: ip, IPPrefixLen: 24, Gateway: '10.89.0.1' } } }
        };
    }

    // 假运行时：ps 列出两个容器，inspect 返回它们，run（helper）返回 hosts
    function makeTwo(policies) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-derived-'));
        const infos = { [ID_A]: info(ID_A, '10.89.0.2'), [ID_B]: info(ID_B, '10.89.0.3') };
        const fake = path.join(dir, 'fake-docker.sh');
        fs.writeFileSync(fake, `#!/bin/sh
case "$1" in
  ps) printf '${ID_A}\\n${ID_B}\\n' ;;
  inspect) cat <<'EOF_INSPECT'
${JSON.stringify(infos[ID_A])}
${JSON.stringify(infos[ID_B])}
EOF_INSPECT
  ;;
  run) printf '10.89.0.1 host.containers.internal\\nnameserver 10.89.0.1\\n' ;;
esac
`, { mode: 0o755 });
        // 状态目录按 id 建：createState 生成随机 id，这里直接写到固定 id 的目录
        for (const [id, policy] of Object.entries(policies)) {
            const p = state.paths(dir, id);
            fs.mkdirSync(path.dirname(p.network), { recursive: true });
            fs.writeFileSync(p.network, JSON.stringify(normalizePolicy(policy)));
        }
        const manager = createNetworkManager({ command: fake, homeDir: dir, imageRef: () => 'img:1', warn: () => {} });
        return { manager, dir };
    }

    const inbound = (source, extra = {}) => ({ action: 'allow', source, ports: '7000', proto: 'tcp', ...extra });

    test('别的容器入站允许 @container:<我> 或 @containers：我的出站多一条派生放行；@any / 暂停 / 拒绝不派生', async () => {
        const { manager, dir } = makeTwo({
            [ID_A]: {},
            [ID_B]: { inbound: [inbound(`@container:${ID_A}`), inbound('@containers', { ports: '8000' }), inbound('@any', { ports: '9000' }), inbound(`@container:${ID_A}`, { ports: '1', enabled: false }), inbound(`@container:${ID_A}`, { ports: '2', action: 'deny' })] }
        });
        try {
            const all = await manager.listManaged();
            const self = all.find(item => item.id === ID_A);
            const endpoints = await manager.resolveEndpoints(self, manager.loadPolicy(ID_A), all);
            expect(endpoints.derived).toEqual([
                { id: ID_B, name: 'boxb', ip: '10.89.0.3', ports: '7000', proto: 'tcp' },
                { id: ID_B, name: 'boxb', ip: '10.89.0.3', ports: '8000', proto: 'tcp' }
            ]);
            expect(endpoints.allow).toEqual(expect.arrayContaining([{ ip: '10.89.0.3', ports: '7000', proto: 'tcp' }, { ip: '10.89.0.3', ports: '8000', proto: 'tcp' }]));
            expect(endpoints.allow.some(a => a.ports === '9000')).toBe(false);
            expect(endpoints.containers).toEqual({ [ID_A]: '10.89.0.2', [ID_B]: '10.89.0.3' });
            expect(await manager.derivedOf('boxa')).toEqual(endpoints.derived);
            expect(await manager.derivedOf('boxb')).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('relatedContainers：规则里引用了对方 / 对方入站向所有容器开放时才相关', async () => {
        const unrelated = makeTwo({ [ID_A]: {}, [ID_B]: {} });
        const byRef = makeTwo({ [ID_A]: { outbound: [{ action: 'allow', target: `@container:${ID_B}` }] }, [ID_B]: {} });
        const open = makeTwo({ [ID_A]: {}, [ID_B]: { inbound: [inbound('@containers')] } });
        const anyOnly = makeTwo({ [ID_A]: {}, [ID_B]: { inbound: [inbound('@any')] } });
        try {
            expect(await unrelated.manager.relatedContainers('boxa')).toEqual([]);
            expect(await byRef.manager.relatedContainers('boxb')).toEqual(['boxa']);
            expect(await open.manager.relatedContainers('boxa')).toEqual(['boxb']);
            expect(await anyOnly.manager.relatedContainers('boxa')).toEqual([]);
        } finally {
            [unrelated, byRef, open, anyOnly].forEach(x => fs.rmSync(x.dir, { recursive: true, force: true }));
        }
    });

    test('resolveRefs：名称换成 id；名称不存在报错；没有名称引用时不查运行时', async () => {
        const { manager, dir } = makeTwo({ [ID_A]: {}, [ID_B]: {} });
        try {
            const policy = normalizePolicy({ outbound: [{ action: 'allow', target: '@container:boxb' }] });
            expect((await manager.resolveRefs(policy)).outbound[0].target).toBe(`@container:${ID_B}`);
            await expect(manager.resolveRefs(normalizePolicy({ outbound: [{ action: 'allow', target: '@container:nobody' }] }))).rejects.toThrow(/找不到容器/);
            const plain = normalizePolicy({});
            expect(await manager.resolveRefs(plain)).toBe(plain);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
