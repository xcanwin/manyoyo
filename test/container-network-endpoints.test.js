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
