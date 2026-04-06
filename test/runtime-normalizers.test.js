'use strict';

const path = require('path');
const {
    parseEnvEntry,
    expandHomeAliasPath,
    normalizeVolume
} = require('../lib/runtime-normalizers');

describe('runtime normalizers', () => {
    test('parseEnvEntry should parse valid env entry', () => {
        expect(parseEnvEntry('OPENAI_API_KEY=sk-test')).toEqual({
            key: 'OPENAI_API_KEY',
            value: 'sk-test'
        });
    });

    test('parseEnvEntry should reject missing separator', () => {
        expect(() => parseEnvEntry('OPENAI_API_KEY')).toThrow('env 格式应为 KEY=VALUE');
    });

    test('parseEnvEntry should reject invalid key', () => {
        expect(() => parseEnvEntry('1KEY=value')).toThrow('env key 非法');
    });

    test('parseEnvEntry should reject dangerous value characters', () => {
        expect(() => parseEnvEntry('KEY=value;rm')).toThrow('env value 含非法字符');
    });

    test('expandHomeAliasPath should expand ~ and $HOME', () => {
        const homeDir = '/tmp/demo-home';
        expect(expandHomeAliasPath('~', homeDir)).toBe(homeDir);
        expect(expandHomeAliasPath('~/work', homeDir)).toBe(path.join(homeDir, 'work'));
        expect(expandHomeAliasPath('$HOME', homeDir)).toBe(homeDir);
        expect(expandHomeAliasPath('$HOME/work', homeDir)).toBe(path.join(homeDir, 'work'));
    });

    test('normalizeVolume should expand only host side aliases', () => {
        const homeDir = '/tmp/demo-home';
        expect(normalizeVolume('~/repo:/workspace/repo', homeDir)).toBe('/tmp/demo-home/repo:/workspace/repo');
        expect(normalizeVolume('$HOME/cache:/root/cache', homeDir)).toBe('/tmp/demo-home/cache:/root/cache');
        expect(normalizeVolume('/tmp/data:/workspace/data', homeDir)).toBe('/tmp/data:/workspace/data');
    });
});
