'use strict';

const path = require('path');
const esbuild = require('esbuild');

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const entry = path.join(repoRoot, 'lib/web/frontend/codemirror-entry.js');
    const outfile = path.join(repoRoot, 'lib/web/frontend/codemirror.bundle.js');

    await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['es2020'],
        charset: 'utf8',
        logLevel: 'info'
    });
}

main().catch(error => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
