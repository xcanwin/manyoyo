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
});
