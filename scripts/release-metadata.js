#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const packageMetadata = require('../package.json');
const { createReleaseMetadata } = require('../lib/release-metadata');

function getArgument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] || '' : '';
}

const toolManifestPath = path.join(__dirname, '../docker/tool-manifest.json');
const toolManifestRaw = fs.readFileSync(toolManifestPath);
const toolManifest = JSON.parse(toolManifestRaw.toString('utf-8'));
const metadata = createReleaseMetadata({
    packageMetadata,
    toolManifest,
    toolManifestSha256: crypto.createHash('sha256').update(toolManifestRaw).digest('hex'),
    npmIntegrity: getArgument('--npm-integrity'),
    imageRepository: getArgument('--image-repository'),
    imageDigest: getArgument('--image-digest')
});

process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
