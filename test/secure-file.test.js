'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeConfigFileSecure } = require('../lib/secure-file');

describe('writeConfigFileSecure', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-secure-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const mode = file => fs.statSync(file).mode & 0o777;

    test('creates the directory 0700 and the file 0600', () => {
        const file = path.join(root, 'newdir', 'manyoyo.json');
        writeConfigFileSecure(file, '{}\n');
        expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
        expect(mode(file)).toBe(0o600);
        expect(mode(path.dirname(file))).toBe(0o700);
    });

    test('tightens an existing 0644 file and a pre-existing ~/.manyoyo-style directory', () => {
        const dir = path.join(root, '.manyoyo');
        fs.mkdirSync(dir, { mode: 0o755 });
        fs.chmodSync(dir, 0o755);
        const file = path.join(dir, 'manyoyo.json');
        fs.writeFileSync(file, 'old', { mode: 0o644 });
        fs.chmodSync(file, 0o644);
        writeConfigFileSecure(file, 'new');
        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        expect(mode(file)).toBe(0o600);
        expect(mode(dir)).toBe(0o700);
    });

    test('does not chmod an unrelated existing directory', () => {
        const dir = path.join(root, 'shared');
        fs.mkdirSync(dir);
        fs.chmodSync(dir, 0o755);
        writeConfigFileSecure(path.join(dir, 'x.json'), 'a');
        expect(mode(dir)).toBe(0o755);
    });

    test('is atomic: no temp files are left and a failed write keeps the old content', () => {
        const file = path.join(root, 'manyoyo.json');
        writeConfigFileSecure(file, 'v1');
        expect(() => writeConfigFileSecure(file, { not: 'a string' })).toThrow();
        expect(fs.readFileSync(file, 'utf8')).toBe('v1');
        expect(fs.readdirSync(root)).toEqual(['manyoyo.json']);
    });

    test('writes through a symlink instead of replacing it', () => {
        const real = path.join(root, 'real.json');
        fs.writeFileSync(real, 'a');
        const link = path.join(root, 'link.json');
        fs.symlinkSync(real, link);
        writeConfigFileSecure(link, 'b');
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(real, 'utf8')).toBe('b');
    });
});
