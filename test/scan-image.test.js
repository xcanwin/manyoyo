'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, scanImage, DEFAULT_ALLOWLIST } = require('../scripts/scan-image');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

describe('scan-image (local pre-scan of a release image)', () => {
    test('defaults to the ghcr image of package.json imageVersion; accepts an explicit image', () => {
        expect(parseArgs([]).image).toBe(`ghcr.io/xcanwin/manyoyo:${pkg.imageVersion}`);
        expect(parseArgs(['ghcr.io/xcanwin/manyoyo:1.2.3-common']).image).toBe('ghcr.io/xcanwin/manyoyo:1.2.3-common');
        expect(() => parseArgs(['--auto-identity'])).toThrow(/未知参数/);
        expect(() => parseArgs(['a', 'b'])).toThrow(/只能指定一个镜像/);
    });

    test('uses the image allowlist and never passes --auto-identity (the local user name would hit libgcrypt)', async () => {
        const calls = [];
        const code = await scanImage({
            image: 'ghcr.io/xcanwin/manyoyo:9.9.9-common',
            runtime: { command: 'podman', env: {} },
            save: (command, args) => { calls.push(['save', command, args]); require('fs').writeFileSync(args[args.indexOf('-o') + 1], 'x'); return 0; },
            scan: args => { calls.push(['scan', args]); return 0; }
        });
        expect(code).toBe(0);
        const save = calls.find(c => c[0] === 'save');
        expect(save[1]).toBe('podman');
        expect(save[2].slice(0, 1)).toEqual(['save']);
        expect(save[2]).toContain('ghcr.io/xcanwin/manyoyo:9.9.9-common');
        const scan = calls.find(c => c[0] === 'scan')[1];
        expect(scan).toEqual(expect.arrayContaining(['--no-inventory', '--allowlist', DEFAULT_ALLOWLIST]));
        expect(scan).not.toContain('--auto-identity');
        expect(DEFAULT_ALLOWLIST.endsWith('scripts/offline/scan-allowlist-image.json')).toBe(true);
    });

    test('returns the scanner exit code and removes the temporary archive in every case', async () => {
        let archive = '';
        const base = {
            image: 'x:1-common',
            runtime: { command: 'docker', env: {} },
            save: (command, args) => { archive = args[args.indexOf('-o') + 1]; fs.writeFileSync(archive, 'x'); return 0; }
        };
        expect(await scanImage({ ...base, scan: () => 1 })).toBe(1);
        expect(fs.existsSync(archive)).toBe(false);
        expect(fs.existsSync(path.dirname(archive))).toBe(false);

        await expect(scanImage({ ...base, save: (command, args) => { archive = args[args.indexOf('-o') + 1]; fs.writeFileSync(archive, 'partial'); return 125; }, scan: () => 0 }))
            .rejects.toThrow(/保存镜像失败/);
        expect(fs.existsSync(path.dirname(archive))).toBe(false);
    });
});
