'use strict';

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/image-publish.yml'), 'utf8');

describe('image-publish workflow', () => {
    test('is manually triggered only, so pushing a branch or tag never publishes', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(push|pull_request|schedule|release):/m);
    });

    test('pushes both architectures to ghcr with the default image name and minimal permissions', () => {
        expect(text).toContain('platforms: linux/amd64,linux/arm64');
        expect(text).toContain('IMAGE_NAME: ghcr.io/xcanwin/manyoyo');
        expect(text).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+packages: write/);
        expect(text).toContain('secrets.GITHUB_TOKEN');
    });

    test('never passes credentials into the build and uses no other secrets', () => {
        const secrets = text.match(/secrets\.[A-Za-z_]+/g) || [];
        expect(new Set(secrets)).toEqual(new Set(['secrets.GITHUB_TOKEN']));
        const buildArgBlocks = text.match(/build-args: \|\n(?:\s+.+\n)+/g) || [];
        expect(buildArgBlocks.length).toBeGreaterThan(0);
        buildArgBlocks.forEach(block => {
            expect(block).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY|secrets\./i);
        });
    });

    test('produces one archive artifact per architecture', () => {
        expect(text).toMatch(/dest=out\/manyoyo-.*-amd64\.tar/);
        expect(text).toMatch(/dest=out\/manyoyo-.*-arm64\.tar/);
        expect(text).toContain('actions/upload-artifact@v4');
    });

    test('validates the image version format before building', () => {
        expect(text).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+-[A-Za-z0-9][A-Za-z0-9_.-]*$");
    });

    test('creates the (gitignored) docker/cache directory that the Dockerfile COPYs, before any build step', () => {
        const mkdir = text.indexOf('mkdir -p docker/cache');
        expect(mkdir).toBeGreaterThan(-1);
        expect(mkdir).toBeLessThan(text.indexOf('docker/build-push-action'));
        const dockerfile = fs.readFileSync(path.join(__dirname, '../docker/manyoyo.Dockerfile'), 'utf8');
        expect(dockerfile).toContain('COPY ./docker/cache/ /cache/');
    });
});
