'use strict';

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/image-publish.yml'), 'utf8');

function jobBlock(name) {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

describe('image-publish workflow', () => {
    test('is manually triggered only, so pushing a branch or tag never publishes', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(push|pull_request|schedule|release):/m);
    });

    test('has a dryRun input, forced on for any ref other than main', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toMatch(/dryRun:\s*\n(?:\s+.*\n)*?\s+type: boolean/);
        expect(text).toContain("github.ref != 'refs/heads/main'");
        expect(text).toContain('DRY_RUN=true');
    });

    test('never overwrites an existing tag: fails when the tag already exists, and has no force switch', () => {
        const prepare = jobBlock('prepare');
        expect(prepare).toContain('docker buildx imagetools inspect');
        expect(prepare).toContain('已存在');
        expect(prepare).toContain('exit 1');
        expect(text).not.toMatch(/force|overwrite/i);
    });

    test('builds each architecture on a native runner (no qemu) and pushes by digest', () => {
        expect(text).not.toContain('setup-qemu-action');
        const build = jobBlock('build');
        const runners = [...build.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]).sort();
        expect(runners).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm']);
        expect(build).toContain('platforms: linux/${{ matrix.arch }}');
        expect(build).toContain('push-by-digest=true');
        expect(build).toContain('name-canonical=true');
        expect(build).not.toContain('linux/amd64,linux/arm64');
    });

    test('the dry run builds only: cacheonly output, no registry login, no digest upload, no manifest merge', () => {
        const build = jobBlock('build');
        expect(build).toContain('type=cacheonly');
        expect(build).toMatch(/docker\/login-action@v4\n\s+if: needs\.prepare\.outputs\.dryRun != 'true'/);
        expect(build).toMatch(/Upload digest[\s\S]*if: needs\.prepare\.outputs\.dryRun != 'true'/);
        expect(jobBlock('merge')).toMatch(/\n    if: needs\.prepare\.outputs\.dryRun != 'true'/);
    });

    test('the two architectures are merged into the multi-arch tag with imagetools create, after both are pushed', () => {
        const merge = jobBlock('merge');
        expect(merge).toContain('needs: [prepare, build]');
        expect(merge).toContain('docker buildx imagetools create');
        expect(merge).toContain('${IMAGE_NAME}:${{ needs.prepare.outputs.imageVersion }}');
        expect(merge).toContain('docker buildx imagetools inspect');
    });

    test('GHA build cache is scoped per architecture', () => {
        expect(text).toContain('cache-from: type=gha,scope=${{ matrix.arch }}');
        expect(text).toContain('cache-to: type=gha,scope=${{ matrix.arch }},mode=max');
    });

    test('no longer builds or uploads image archives (nothing consumed them)', () => {
        expect(text).not.toContain('actions/upload-artifact@v7\n        with:\n          name: manyoyo-image-');
        expect(text).not.toMatch(/dest=out\//);
        expect(text).not.toContain('Build amd64 archive');
        expect(text).not.toContain('Build arm64 archive');
    });

    test('only the push path has packages: write; the IMAGE_NAME default stays', () => {
        expect(text).toContain('IMAGE_NAME: ghcr.io/xcanwin/manyoyo');
        expect(jobBlock('build')).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+packages: write/);
        expect(jobBlock('merge')).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+packages: write/);
        expect(jobBlock('prepare')).not.toContain('packages: write');
        expect(text).toContain('secrets.GITHUB_TOKEN');
    });

    test('never passes credentials into the build and uses no other secrets', () => {
        const secrets = text.match(/secrets\.[A-Za-z_]+/g) || [];
        expect(new Set(secrets)).toEqual(new Set(['secrets.GITHUB_TOKEN']));
        const buildArgBlocks = text.match(/build-args: \|\n(?: {12}\S.*\n)+/g) || [];
        expect(buildArgBlocks.length).toBeGreaterThan(0);
        buildArgBlocks.forEach(block => {
            expect(block).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY|secrets\./i);
        });
    });

    test('validates the image version format before building', () => {
        expect(text).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+-[A-Za-z0-9][A-Za-z0-9_.-]*$");
    });

    test('creates the (gitignored) docker/cache directory that the Dockerfile COPYs, before the build step', () => {
        const mkdir = text.indexOf('mkdir -p docker/cache');
        expect(mkdir).toBeGreaterThan(-1);
        expect(mkdir).toBeLessThan(text.indexOf('docker/build-push-action'));
        const dockerfile = fs.readFileSync(path.join(__dirname, '../docker/manyoyo.Dockerfile'), 'utf8');
        expect(dockerfile).toContain('COPY ./docker/cache/ /cache/');
    });

    test('builds with official mirrors (the runner is overseas; China mirrors crawl at ~120 kB/s) and the Dockerfile honors an empty APT_MIRROR', () => {
        const blocks = text.match(/build-args: \|\n(?: {12}\S.*\n)+/g) || [];
        expect(blocks).toHaveLength(1);
        blocks.forEach(block => {
            expect(block).toMatch(/^\s+APT_MIRROR=$/m);
            expect(block).toContain('NODEJS_MIRROR=https://nodejs.org/dist');
            expect(block).toContain('NPM_REGISTRY=https://registry.npmjs.org/');
            expect(block).toContain('PIP_INDEX_URL=https://pypi.org/simple');
        });
        const dockerfile = fs.readFileSync(path.join(__dirname, '../docker/manyoyo.Dockerfile'), 'utf8');
        const seds = dockerfile.match(/.*sed -i "s\|http.*ubuntu\.sources.*/g) || [];
        expect(seds).toHaveLength(2);
        seds.forEach(line => expect(line).toContain('if [ -n "${APT_MIRROR}" ]'));
        expect(dockerfile).toContain('ARG NODEJS_MIRROR=https://mirrors.tencent.com/nodejs-release/');
        expect(dockerfile).not.toContain('NVM_NODEJS_ORG_MIRROR=https://mirrors.tencent.com');
    });
});
