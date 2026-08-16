'use strict';

const fs = require('fs');
const path = require('path');
const { createReleaseMetadata } = require('../lib/release-metadata');

describe('release metadata', () => {
    test('links npm, image and tool-manifest artifacts through one compatibility record', () => {
        const metadata = createReleaseMetadata({
            packageMetadata: { name: '@xcanwin/manyoyo', version: '6.0.5', imageVersion: '1.9.1-common', engines: { node: '>=22.0.0' } },
            toolManifest: { schemaVersion: 1 },
            toolManifestSha256: 'a'.repeat(64),
            npmIntegrity: 'sha512-test',
            imageRepository: 'ghcr.io/xcanwin/manyoyo',
            imageDigest: 'sha256:abc'
        });

        expect(metadata).toEqual(expect.objectContaining({
            schemaVersion: 1,
            npm: { name: '@xcanwin/manyoyo', version: '6.0.5', integrity: 'sha512-test' },
            image: expect.objectContaining({ version: '1.9.1-common', digest: 'sha256:abc', platforms: ['linux/amd64', 'linux/arm64'] }),
            toolManifest: { schemaVersion: 1, sha256: 'a'.repeat(64) },
            compatibility: { node: '>=22.0.0', runtimes: ['docker', 'podman'], platforms: ['linux/amd64', 'linux/arm64'] }
        }));
    });

    test('release workflows upload image digest and npm integrity metadata', () => {
        const imageWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/image-publish.yml'), 'utf8');
        const npmWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/npm-publish.yml'), 'utf8');

        expect(imageWorkflow).toContain('scripts/release-metadata.js');
        expect(imageWorkflow).toContain('manyoyo-release-metadata');
        expect(npmWorkflow).toContain('npm pack --pack-destination');
        expect(npmWorkflow).toContain('--npm-integrity');
    });
});
