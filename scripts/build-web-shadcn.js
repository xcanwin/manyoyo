'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const frontendShadcnDir = path.join(__dirname, '..', 'frontend-shadcn');

const result = spawnSync('npm', ['run', 'build:single'], {
    cwd: frontendShadcnDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

if (result.error) {
    throw result.error;
}

process.exit(result.status == null ? 1 : result.status);
