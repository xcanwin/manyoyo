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
});
