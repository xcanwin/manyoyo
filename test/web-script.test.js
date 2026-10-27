'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'web.js');
const indexHtml = path.join(__dirname, '..', 'lib', 'web', 'index.html');

describe('scripts/web.js build', () => {
    // 流水线里前端只构建一次再分发给各构建 job；打包时 npm pack 的 prepack 不能再重复构建
    (fs.existsSync(indexHtml) ? test : test.skip)('MANYOYO_SKIP_WEB_BUILD=1 reuses the existing lib/web/index.html and never calls npm', () => {
        const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-nobin-'));
        try {
            const result = spawnSync(process.execPath, [script, 'build'], {
                encoding: 'utf-8',
                env: { ...process.env, MANYOYO_SKIP_WEB_BUILD: '1', PATH: emptyBin }
            });
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('跳过');
        } finally {
            fs.rmSync(emptyBin, { recursive: true, force: true });
        }
    });

    // CI 上装依赖偶发 ECONNRESET：失败要清掉半成品 node_modules 重试，而不是整条流水线变红
    test('retries a failing npm ci (cleaning node_modules) and then builds', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-webretry-'));
        try {
            fs.mkdirSync(path.join(root, 'scripts'));
            fs.mkdirSync(path.join(root, 'frontend'));
            fs.copyFileSync(script, path.join(root, 'scripts', 'web.js'));
            const bin = path.join(root, 'bin');
            fs.mkdirSync(bin);
            const log = path.join(root, 'npm.log');
            const count = path.join(root, 'ci.count');
            fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = "ci" ]; then
  n=$(cat ${count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${count}
  mkdir -p node_modules/half
  [ "$n" -lt 3 ] && exit 1
  rm -rf node_modules/half; exit 0
fi
exit 0
`, { mode: 0o755 });
            const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'web.js'), 'build'], {
                encoding: 'utf-8',
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MANYOYO_NPM_RETRY_MS: '10' }
            });
            expect(result.status).toBe(0);
            expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['ci', 'ci', 'ci', 'run build:single']);
            expect(result.stderr).toContain('重试');

            // 三次都失败：带着失败退出码退出，并清掉半成品
            fs.rmSync(count, { force: true });
            fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules/half\n[ "$1" = "ci" ] && exit 7\nexit 0\n', { mode: 0o755 });
            fs.rmSync(path.join(root, 'frontend', 'node_modules'), { recursive: true, force: true });
            const failed = spawnSync(process.execPath, [path.join(root, 'scripts', 'web.js'), 'build'], {
                encoding: 'utf-8',
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MANYOYO_NPM_RETRY_MS: '10' }
            });
            expect(failed.status).toBe(7);
            expect(fs.existsSync(path.join(root, 'frontend', 'node_modules'))).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
