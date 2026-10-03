'use strict';

const { normalizeMirrors } = require('../lib/runtime-normalizers');
const { buildMirrorEnvArgs, buildAptMirrorExecArgs, applyAptMirror, APT_MIRROR_SCRIPT } = require('../lib/mirrors');
const { buildContainerRunArgs } = require('../lib/container-run');
const { MIRROR_PRESETS, listMirrorPresets } = require('../lib/setup');

describe('normalizeMirrors', () => {
    test('empty / missing means official defaults (all empty)', () => {
        expect(normalizeMirrors(undefined)).toEqual({ apt: '', npm: '', pip: '' });
        expect(normalizeMirrors({})).toEqual({ apt: '', npm: '', pip: '' });
        expect(normalizeMirrors({ apt: '  ', npm: '' })).toEqual({ apt: '', npm: '', pip: '' });
    });

    test('keeps valid http/https urls (trimmed)', () => {
        expect(normalizeMirrors({ apt: ' https://mirrors.aliyun.com ', npm: 'http://127.0.0.1:4873/', pip: 'https://pypi.tuna.tsinghua.edu.cn/simple' }))
            .toEqual({ apt: 'https://mirrors.aliyun.com', npm: 'http://127.0.0.1:4873/', pip: 'https://pypi.tuna.tsinghua.edu.cn/simple' });
    });

    test.each([
        ['ftp://x.com', /http/],
        ['mirrors.aliyun.com', /http/],
        ['https://a.com/a b', /非法字符|空白/],
        ['https://a.com/$(id)', /非法字符/],
        ['https://a.com/;rm', /非法字符/],
        ['https://a.com/`x`', /非法字符/],
        ['https://a.com/"x', /非法字符/],
        ["https://a.com/'x", /非法字符/],
        ['https://a.com/\\x', /非法字符/],
        [`https://a.com/${'a'.repeat(300)}`, /过长/]
    ])('rejects %s', (bad, message) => {
        expect(() => normalizeMirrors({ npm: bad })).toThrow(message);
    });

    test('rejects unknown keys and non-objects', () => {
        expect(() => normalizeMirrors({ gem: 'https://a.com' })).toThrow(/gem/);
        expect(() => normalizeMirrors('https://a.com')).toThrow(/对象/);
        expect(() => normalizeMirrors({ npm: 5 })).toThrow(/字符串/);
    });
});

describe('buildMirrorEnvArgs', () => {
    test('npm and pip become container env; https pip has no trusted host', () => {
        expect(buildMirrorEnvArgs({ apt: 'https://m.com', npm: 'https://n.com/', pip: 'https://p.com/simple' }, []))
            .toEqual(['--env', 'NPM_CONFIG_REGISTRY=https://n.com/', '--env', 'PIP_INDEX_URL=https://p.com/simple']);
    });

    test('http pip adds PIP_TRUSTED_HOST with the host', () => {
        expect(buildMirrorEnvArgs({ pip: 'http://192.168.1.2:3141/simple' }, []))
            .toEqual(['--env', 'PIP_INDEX_URL=http://192.168.1.2:3141/simple', '--env', 'PIP_TRUSTED_HOST=192.168.1.2']);
    });

    test('user-set env wins and nothing is injected for official defaults', () => {
        expect(buildMirrorEnvArgs({ npm: 'https://n.com/' }, ['--env', 'NPM_CONFIG_REGISTRY=https://mine/'])).toEqual([]);
        expect(buildMirrorEnvArgs({ apt: '', npm: '', pip: '' }, [])).toEqual([]);
        expect(buildMirrorEnvArgs(undefined, [])).toEqual([]);
    });
});

describe('buildContainerRunArgs with mirrors', () => {
    const base = { containerName: 'c', hostPath: '/h', containerPath: '/w', imageName: 'i', imageVersion: '1.0.0-common', containerEnvs: ['--env', 'A=1'] };
    test('injects mirror env before the image and keeps user env', () => {
        const args = buildContainerRunArgs({ ...base, mirrors: { npm: 'https://n.com/' } });
        expect(args).toEqual(expect.arrayContaining(['--env', 'A=1', '--env', 'NPM_CONFIG_REGISTRY=https://n.com/']));
        expect(args.indexOf('NPM_CONFIG_REGISTRY=https://n.com/')).toBeLessThan(args.indexOf('i:1.0.0-common'));
    });
    test('no mirrors: args unchanged', () => {
        expect(buildContainerRunArgs(base)).toEqual(buildContainerRunArgs({ ...base, mirrors: {} }));
    });
});

describe('apt mirror via exec', () => {
    test('the mirror url only travels through env, never inside the script', () => {
        const url = 'https://mirrors.aliyun.com';
        const args = buildAptMirrorExecArgs('box', url);
        expect(args).toEqual(['exec', '--user', 'root', '--env', `MANYOYO_APT_MIRROR=${url}`, 'box', '/bin/sh', '-c', APT_MIRROR_SCRIPT]);
        expect(APT_MIRROR_SCRIPT).not.toContain(url);
        expect(APT_MIRROR_SCRIPT).toContain('$MANYOYO_APT_MIRROR');
        expect(APT_MIRROR_SCRIPT).toContain('.manyoyo-orig'); // 备份原文件，重复执行/换源都幂等
    });

    test('applyAptMirror skips when empty, warns (does not throw) on failure', () => {
        const calls = [];
        const warns = [];
        applyAptMirror({ dockerExecArgs: args => calls.push(args), containerName: 'box', mirrors: { apt: '' }, warn: m => warns.push(m) });
        expect(calls).toEqual([]);
        applyAptMirror({ dockerExecArgs: () => { throw new Error('boom'); }, containerName: 'box', mirrors: { apt: 'https://m.com' }, warn: m => warns.push(m) });
        expect(warns.join('\n')).toMatch(/apt/);
    });
});

describe('mirror presets (single source of truth)', () => {
    test('each tool has an official default plus named presets, all passing validation', () => {
        for (const tool of ['apt', 'npm', 'pip']) {
            expect(MIRROR_PRESETS[tool].length).toBeGreaterThanOrEqual(3);
            MIRROR_PRESETS[tool].forEach(item => normalizeMirrors({ [tool]: item.value }));
        }
        for (const tool of ['apt', 'npm', 'pip']) {
            expect(listMirrorPresets()[tool].map(item => item.label)).toEqual(expect.arrayContaining(['阿里云', '腾讯云']));
        }
        expect(listMirrorPresets().apt.map(item => item.label)).toEqual(expect.arrayContaining(['清华', '中科大']));
    });
});

describe('runWithEnvFile', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { runWithEnvFile } = require('../lib/container-run');

    test('moves --env KEY=value into a 0600 env file that is removed after exec', () => {
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-envfile-')), 'tmp');
        let seen;
        runWithEnvFile(['run', '-d', '--env', 'ANTHROPIC_AUTH_TOKEN=sk-secret', '--env', 'KEEP', '--env', 'A=b=c', 'img'], dir, args => {
            seen = args;
            const file = args[args.indexOf('--env-file') + 1];
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
            expect(fs.readFileSync(file, 'utf8')).toBe('ANTHROPIC_AUTH_TOKEN=sk-secret\nA=b=c\n');
        });
        expect(seen.join(' ')).not.toContain('sk-secret');
        expect(seen).toEqual(['run', '-d', '--env-file', expect.any(String), '--env', 'KEEP', 'img']);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('removes the file when exec throws, and leaves args alone without KEY=value envs', () => {
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-envfile-')), 'tmp');
        expect(() => runWithEnvFile(['run', '--env', 'A=b'], dir, () => { throw new Error('boom'); })).toThrow('boom');
        expect(fs.readdirSync(dir)).toEqual([]);
        const untouched = ['run', '--env', 'KEEP'];
        expect(runWithEnvFile(untouched, path.join(dir, 'none'), args => args)).toBe(untouched);
    });
});
