'use strict';

// 网页前端（frontend/）的构建 / 开发 / 测试入口：node scripts/web.js <build|build-release|dev|test>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const frontendDir = path.join(__dirname, '..', 'frontend');
const shell = process.platform === 'win32';
const COMMANDS = {
    build: ['run', 'build:single'],
    'build-release': ['run', 'build:release'],
    dev: ['run', 'dev'],
    test: ['test']
};

function run(args) {
    const result = spawnSync('npm', args, { cwd: frontendDir, stdio: 'inherit', shell });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status == null ? 1 : result.status);
    }
}

// 装依赖要访问 npm 仓库，CI 上偶发 ECONNRESET（整条流水线因此红）：失败就清掉半成品 node_modules 重试，最多 3 次
function installWithRetry() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = spawnSync('npm', ['ci'], { cwd: frontendDir, stdio: 'inherit', shell });
        if (!result.error && result.status === 0) return;
        fs.rmSync(path.join(frontendDir, 'node_modules'), { recursive: true, force: true });
        if (attempt === 3) process.exit(result.status == null ? 1 : result.status);
        const delay = attempt * Number(process.env.MANYOYO_NPM_RETRY_MS || 5000);
        console.warn(`前端依赖安装失败，${Math.round(delay / 1000)} 秒后重试（${attempt}/3）`);
        spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${delay})`]);
    }
}

const action = process.argv[2];
if (!COMMANDS[action]) {
    console.error('用法: node scripts/web.js <build|build-release|dev|test>');
    process.exit(2);
}

// 流水线里前端只构建一次再分发给各构建 job：产物已在位时，打包用的 npm pack（prepack）不再重复构建
if (action === 'build' && process.env.MANYOYO_SKIP_WEB_BUILD === '1' && fs.existsSync(path.join(__dirname, '..', 'lib', 'web', 'index.html'))) {
    console.log('已有 lib/web/index.html，跳过前端构建（MANYOYO_SKIP_WEB_BUILD=1）');
    process.exit(0);
}

if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) {
    installWithRetry();
}
run(COMMANDS[action]);
