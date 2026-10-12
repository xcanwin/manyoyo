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
    run(['ci']);
}
run(COMMANDS[action]);
