'use strict';

// 真实容器运行时上的镜像导入：用安装包里的 finish-import.sh（Linux 包与精简包走的“外部运行时”路径）
// 对一个本地生成的小镜像执行真实的 `<runtime> load`。没有可用的 podman / docker 时整组跳过。

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FINISH = path.join(__dirname, '../../scripts/offline/finish-import.sh');

function usableRuntime() {
    for (const candidate of ['podman', 'docker']) {
        const probe = spawnSync(candidate, ['info'], { stdio: 'ignore', timeout: 15000 });
        if (probe.status === 0) return candidate;
    }
    return '';
}

const runtime = usableRuntime();
if (!runtime) {
    // eslint-disable-next-line no-console
    console.warn('[integration] 没有可用的 podman / docker，跳过 Linux 镜像导入集成测试');
}
const maybe = runtime ? describe : describe.skip;

maybe(`finish-import.sh with a real ${runtime || 'runtime'}`, () => {
    let dir;
    let ref;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-import-it-'));
        ref = `localhost/manyoyo-it/import-${crypto.randomBytes(4).toString('hex')}:1`;
    });
    afterAll(() => {
        spawnSync(runtime, ['rmi', '-f', ref], { stdio: 'ignore' });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('loads the archive, writes the done marker, removes the archive and the loading marker', () => {
        // 空根文件系统的最小镜像：import 一个只有一个文件的 tar，再 save 成归档，最后删掉本地镜像
        const rootfs = path.join(dir, 'rootfs');
        fs.mkdirSync(rootfs);
        fs.writeFileSync(path.join(rootfs, 'hello'), 'hi');
        const layer = path.join(dir, 'layer.tar');
        expect(spawnSync('tar', ['-cf', layer, '-C', rootfs, '.']).status).toBe(0);
        expect(spawnSync(runtime, ['import', layer, ref], { encoding: 'utf-8' }).status).toBe(0);
        const archive = path.join(dir, 'image.tar');
        expect(spawnSync(runtime, ['save', '-o', archive, ref], { encoding: 'utf-8' }).status).toBe(0);
        expect(spawnSync(runtime, ['rmi', '-f', ref], { encoding: 'utf-8' }).status).toBe(0);
        expect(spawnSync(runtime, ['image', 'exists', ref]).status === 0 || spawnSync(runtime, ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0).toBe(false);

        const marker = path.join(dir, 'loading.json');
        const done = path.join(dir, 'image-loaded');
        const log = path.join(dir, 'import.log');
        const result = spawnSync('sh', [FINISH], {
            encoding: 'utf-8',
            env: {
                ...process.env,
                MANYOYO_IMPORT_STATE: done,
                MANYOYO_IMPORT_MARKER: marker,
                MANYOYO_IMPORT_LOG: log,
                MANYOYO_IMPORT_ARCHIVE: archive,
                MANYOYO_IMPORT_REF: ref,
                MANYOYO_IMPORT_KIND: 'external',
                MANYOYO_IMPORT_PODMAN_ROOT: path.join(dir, 'unused'),
                MANYOYO_IMPORT_CMD: runtime
            },
            timeout: 120000
        });
        expect(result.status).toBe(0);
        expect(fs.existsSync(done)).toBe(true);
        expect(fs.existsSync(archive)).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
        expect(spawnSync(runtime, ['image', 'inspect', ref], { stdio: 'ignore' }).status).toBe(0);
    }, 180000);

    test('a broken archive keeps it for a retry and leaves no done marker', () => {
        const archive = path.join(dir, 'broken.tar');
        fs.writeFileSync(archive, 'not an image');
        const done = path.join(dir, 'broken-done');
        const result = spawnSync('sh', [FINISH], {
            encoding: 'utf-8',
            env: {
                ...process.env,
                MANYOYO_IMPORT_STATE: done,
                MANYOYO_IMPORT_MARKER: path.join(dir, 'broken-loading.json'),
                MANYOYO_IMPORT_LOG: path.join(dir, 'broken.log'),
                MANYOYO_IMPORT_ARCHIVE: archive,
                MANYOYO_IMPORT_REF: ref,
                MANYOYO_IMPORT_KIND: 'external',
                MANYOYO_IMPORT_PODMAN_ROOT: path.join(dir, 'unused'),
                MANYOYO_IMPORT_CMD: runtime
            },
            timeout: 60000
        });
        expect(result.status).not.toBe(0);
        expect(fs.existsSync(done)).toBe(false);
        expect(fs.existsSync(archive)).toBe(true);
    }, 90000);
});
