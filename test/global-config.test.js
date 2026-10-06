const fs = require('fs');
const os = require('os');
const path = require('path');

const { getManyoyoConfigPath, syncGlobalImageVersion } = require('../lib/global-config');

describe('global-config', () => {
    test('should update imageVersion in existing manyoyo.json and preserve other keys', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-global-config-'));
        const configPath = getManyoyoConfigPath(homeDir);

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, `${JSON.stringify({
                imageVersion: '1.8.7-common',
                runs: {
                    claude: {
                        containerName: 'my-claude'
                    }
                }
            }, null, 4)}\n`);

            const result = syncGlobalImageVersion('1.8.8-common', { homeDir });

            expect(result).toEqual(expect.objectContaining({
                updated: true,
                reason: 'updated',
                path: configPath
            }));

            const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            expect(savedConfig.imageVersion).toBe('1.8.8-common');
            expect(savedConfig.runs.claude.containerName).toBe('my-claude');
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    test('should create manyoyo.json when missing', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-global-config-'));
        const configPath = getManyoyoConfigPath(homeDir);

        try {
            const result = syncGlobalImageVersion('2.0.0-common', { homeDir });

            expect(result).toEqual(expect.objectContaining({
                updated: true,
                reason: 'created',
                path: configPath
            }));

            const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            expect(savedConfig).toEqual({ imageVersion: '2.0.0-common' });
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    test('should not overwrite invalid manyoyo.json', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-global-config-'));
        const configPath = getManyoyoConfigPath(homeDir);

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, '{ invalid json5', 'utf8');

            const before = fs.readFileSync(configPath, 'utf8');
            const result = syncGlobalImageVersion('2.0.1-common', { homeDir });
            const after = fs.readFileSync(configPath, 'utf8');

            expect(result).toEqual(expect.objectContaining({
                updated: false,
                reason: 'parse-error',
                path: configPath
            }));
            expect(after).toBe(before);
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    test('should preserve json5 comments when updating imageVersion', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-global-config-'));
        const configPath = getManyoyoConfigPath(homeDir);

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, [
                '{',
                '    // global image version',
                '    imageVersion: "1.8.9-common",',
                '    runs: {',
                '        // keep this run comment',
                '        claude: {',
                '            containerName: "my-claude"',
                '        }',
                '    }',
                '}'
            ].join('\n'), 'utf8');

            const result = syncGlobalImageVersion('1.8.10-common', { homeDir });

            expect(result).toEqual(expect.objectContaining({
                updated: true,
                reason: 'updated',
                path: configPath
            }));

            const savedText = fs.readFileSync(configPath, 'utf8');
            expect(savedText).toContain('// global image version');
            expect(savedText).toContain('// keep this run comment');
            expect(savedText).toContain('imageVersion: "1.8.10-common"');
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    test('writes manyoyo.json 0600 inside a 0700 ~/.manyoyo, also when rewriting a world-readable one', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-global-config-perm-'));
        const configPath = getManyoyoConfigPath(homeDir);
        try {
            syncGlobalImageVersion('1.8.8-common', { homeDir });
            expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);

            fs.chmodSync(configPath, 0o644);
            fs.chmodSync(path.dirname(configPath), 0o755);
            syncGlobalImageVersion('1.8.9-common', { homeDir });
            expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
            expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });
});

describe('global-config 格式保持', () => {
    test('imageVersion 缺失时插入且保留注释，头部注释含 { 不受影响', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { syncGlobalImageVersion } = require('../lib/global-config');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-gc-'));
        try {
            fs.mkdirSync(path.join(home, '.manyoyo'));
            const p = path.join(home, '.manyoyo', 'manyoyo.json');
            fs.writeFileSync(p, '// 注释 {x}\n{\n    // 保留\n    yolo: "c",\n}\n');
            syncGlobalImageVersion('2.0.0-common', { homeDir: home });
            expect(fs.readFileSync(p, 'utf-8')).toBe('// 注释 {x}\n{\n    "imageVersion": "2.0.0-common",\n    // 保留\n    yolo: "c",\n}\n');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
