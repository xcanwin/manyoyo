'use strict';

// 真实容器运行时上的 npm run scan:image：用小镜像验证“干净的通过、带 /etc/evil.pem 的命中”。
// 没有可用的 podman / docker 时整组跳过。

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../scripts/scan-image.js');

// 与被测脚本选同一个运行时（docker 优先）：两个都装了的机器（如 CI 的 ubuntu）上，镜像必须导入脚本会去 save 的那个
function usableRuntime() {
    for (const candidate of ['docker', 'podman']) {
        const probe = spawnSync(candidate, ['info'], { stdio: 'ignore', timeout: 15000 });
        if (probe.status === 0) return candidate;
    }
    return '';
}

const runtime = usableRuntime();
if (!runtime) {
    // eslint-disable-next-line no-console
    console.warn('[integration] 没有可用的 podman / docker，跳过 scan:image 集成测试');
}
const maybe = runtime ? describe : describe.skip;

maybe(`scan:image with a real ${runtime || 'runtime'}`, () => {
    let dir;
    const refs = [];

    function makeImage(files) {
        const rootfs = path.join(dir, `rootfs-${refs.length}`);
        for (const [name, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(rootfs, name)), { recursive: true });
            fs.writeFileSync(path.join(rootfs, name), content);
        }
        const layer = path.join(dir, `layer-${refs.length}.tar`);
        expect(spawnSync('tar', ['-cf', layer, '-C', rootfs, '.']).status).toBe(0);
        const ref = `localhost/manyoyo-it/scan-${crypto.randomBytes(4).toString('hex')}:1`;
        expect(spawnSync(runtime, ['import', layer, ref], { encoding: 'utf-8' }).status).toBe(0);
        refs.push(ref);
        return ref;
    }

    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-scan-image-it-')); });
    afterAll(() => {
        refs.forEach(ref => spawnSync(runtime, ['rmi', '-f', ref], { stdio: 'ignore' }));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a clean image passes (exit 0)', () => {
        const ref = makeImage({ 'hello.txt': 'hello' });
        const result = spawnSync(process.execPath, [SCRIPT, ref], { encoding: 'utf-8' });
        expect(result.status).toBe(0);
    });

    test('an image carrying /etc/evil.pem is flagged (exit 1) and the report names the file', () => {
        const ref = makeImage({ 'etc/evil.pem': 'not really a key' });
        const result = spawnSync(process.execPath, [SCRIPT, ref], { encoding: 'utf-8' });
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('evil.pem');
    });
});
