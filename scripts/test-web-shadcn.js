'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const frontendShadcnDir = path.join(__dirname, '..', 'frontend-shadcn');
const shell = process.platform === 'win32';

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: frontendShadcnDir,
        stdio: 'inherit',
        shell
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status == null ? 1 : result.status);
    }
}

if (!fs.existsSync(path.join(frontendShadcnDir, 'node_modules'))) {
    run('npm', ['ci']);
}

run('npm', ['test']);
