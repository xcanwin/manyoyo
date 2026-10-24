'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../lib/container-state');
const { createNetworkManager } = require('../lib/container-network');

const ID = 'abcdef0123456789';
const DEFAULT_IMAGE = 'reg/manyoyo:2.3.0-common';
const OWN_IMAGE = 'reg/manyoyo:2.1.0-common';

// 假运行时：记录每次 helper（run）用的镜像；不在 existing 里的镜像报 podman 的 “image not known”；
// 在 noNft 里的镜像（模拟 2.1.x 及更早）跑 nft 报找不到命令
function setup({ existing, noNft = [], ownImage = OWN_IMAGE }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-fallback-'));
    const log = path.join(dir, 'runs.log');
    const info = {
        Name: '/box',
        State: { Running: true, StartedAt: '2026-10-24T00:00:00Z' },
        Config: { Image: ownImage, Labels: { 'manyoyo.id': ID }, Env: [] },
        HostConfig: {},
        NetworkSettings: { Networks: { manyoyo: { IPAddress: '10.89.0.2', IPPrefixLen: 24, Gateway: '10.89.0.1' } } }
    };
    const fake = path.join(dir, 'fake-runtime.js');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const existing = ${JSON.stringify(existing)};
const noNft = ${JSON.stringify(noNft)};
if (args[0] === 'ps') { console.log(${JSON.stringify(ID)}); process.exit(0); }
if (args[0] === 'inspect') { console.log(${JSON.stringify(JSON.stringify(info))}); process.exit(0); }
if (args[0] === 'network') process.exit(0);
if (args[0] === 'run') {
  const image = args.find(a => /^reg\\//.test(a));
  const entry = args[args.indexOf('--entrypoint') + 1];
  fs.appendFileSync(${JSON.stringify(log)}, image + ' ' + entry + '\\n');
  if (!existing.includes(image)) { process.stderr.write('Error: ' + image + ': image not known\\n'); process.exit(125); }
  if (entry === 'nft' && noNft.includes(image)) { process.stderr.write('exec: "nft": executable file not found in $PATH\\n'); process.exit(127); }
  if (entry === 'cat') console.log('10.89.0.1 host.containers.internal\\nnameserver 10.89.0.1');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
    state.createState({ homeDir: dir, id: ID, envLines: [], meta: { name: 'box' }, netRequired: true });
    const manager = createNetworkManager({ command: fake, homeDir: dir, imageRef: () => DEFAULT_IMAGE, warn: () => {} });
    const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
    return { manager, dir, runs };
}

describe('helper 镜像：优先 serve 默认镜像，缺失才退回容器自己的镜像', () => {
    test('默认镜像可用：只用默认镜像', async () => {
        const { manager, dir, runs } = setup({ existing: [DEFAULT_IMAGE, OWN_IMAGE] });
        try {
            await manager.apply('box', { expectId: ID });
            expect(runs().length).toBeGreaterThan(0);
            expect(runs().every(line => line.startsWith(DEFAULT_IMAGE))).toBe(true);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('回归：默认镜像有 nft、容器自己的旧镜像没有 nft：仍然成功（用 2.1.x 建的容器不能因此用不了）', async () => {
        const { manager, dir, runs } = setup({ existing: [DEFAULT_IMAGE, OWN_IMAGE], noNft: [OWN_IMAGE] });
        try {
            const result = await manager.apply('box', { expectId: ID });
            expect(result.status).toBe('applied');
            expect(runs().some(line => line.startsWith(OWN_IMAGE))).toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('默认镜像本地没有：改用容器自己的镜像，成功', async () => {
        const { manager, dir, runs } = setup({ existing: [OWN_IMAGE] });
        try {
            const result = await manager.apply('box', { expectId: ID });
            expect(result.status).toBe('applied');
            expect(runs().some(line => line.startsWith(`${OWN_IMAGE} nft`))).toBe(true);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('两个镜像都没有：失败即关闭，报错里写出试过的两个镜像，状态记 error', async () => {
        const { manager, dir } = setup({ existing: [] });
        try {
            await expect(manager.apply('box', { expectId: ID })).rejects.toThrow(/网络规则下发失败/);
            await expect(manager.apply('box', { expectId: ID })).rejects.toThrow(new RegExp(`${DEFAULT_IMAGE}.*${OWN_IMAGE}`));
            expect(state.readNetStatus(dir, ID).status).toBe('error');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('不是“镜像缺失”的失败（例如默认镜像里 nft 报错）：不换镜像重试，直接失败', async () => {
        const { manager, dir, runs } = setup({ existing: [DEFAULT_IMAGE, OWN_IMAGE], noNft: [DEFAULT_IMAGE] });
        try {
            await expect(manager.apply('box', { expectId: ID })).rejects.toThrow(/网络规则下发失败/);
            expect(runs().some(line => line.startsWith(OWN_IMAGE))).toBe(false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('容器自己的镜像和默认镜像是同一个：缺失时只试一次', async () => {
        const { manager, dir, runs } = setup({ existing: [], ownImage: DEFAULT_IMAGE });
        try {
            await expect(manager.apply('box', { expectId: ID })).rejects.toThrow(/网络规则下发失败/);
            expect(runs().filter(line => line.endsWith(' cat'))).toHaveLength(1);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
