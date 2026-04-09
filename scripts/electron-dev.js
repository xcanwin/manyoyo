'use strict';

const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');
const entry = path.join(__dirname, '..', 'apps', 'electron', 'main.cjs');
const args = [];

if (typeof process.getuid === 'function' && process.getuid() === 0) {
    args.push('--no-sandbox');
}
args.push(entry);

const child = spawn(electronBinary, args, {
    stdio: 'inherit',
    env: process.env
});

child.on('exit', code => {
    process.exit(typeof code === 'number' ? code : 0);
});

child.on('error', error => {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
});
