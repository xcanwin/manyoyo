'use strict';

// 网页前端（frontend/）的构建 / 开发 / 测试入口：node scripts/web.js <build|dev|test>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const frontendDir = path.join(__dirname, '..', 'frontend');
const shell = process.platform === 'win32';
const COMMANDS = {
    build: ['run', 'build:single'],
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
    console.error('用法: node scripts/web.js <build|dev|test>');
    process.exit(2);
}

if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) {
    run(['ci']);
}
run(COMMANDS[action]);
