/**
 * MANYOYO 单元测试
 * 运行: npm test
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BIN_PATH = path.join(__dirname, '../bin/manyoyo.js');

describe('MANYOYO CLI', () => {
    // ==============================================================================
    // 基础命令测试
    // ==============================================================================

    describe('Basic Commands', () => {
        test('no args should display help message', () => {
            const output = execSync(`node ${BIN_PATH}`, { encoding: 'utf-8' });
            expect(output).toContain('Usage: manyoyo [options]');
            expect(output).toContain('MANYOYO');
        });

        test('--help should display help message', () => {
            const output = execSync(`node ${BIN_PATH} --help`, { encoding: 'utf-8' });
            expect(output).toContain('MANYOYO');
            expect(output).toContain('--help');
            expect(output).toContain('--version');
        });

        test('--version should display version', () => {
            const output = execSync(`node ${BIN_PATH} --version`, { encoding: 'utf-8' });
            expect(output).toMatch(/^\d+\.\d+\.\d+/);
        });

        test('--show-config should output valid JSON', () => {
            const output = execSync(`node ${BIN_PATH} --show-config`, { encoding: 'utf-8' });
            const config = JSON.parse(output);
            expect(config).toHaveProperty('hostPath');
            expect(config).toHaveProperty('containerName');
            expect(config).toHaveProperty('imageName');
            expect(config).toHaveProperty('imageVersion');
        });
    });

    // ==============================================================================
    // 敏感信息脱敏测试
    // ==============================================================================

    describe('Sensitive Data Sanitization', () => {
        test('--show-config should sanitize TOKEN values', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "ANTHROPIC_AUTH_TOKEN=sk-abcd1234efgh5678"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const tokenEnv = config.env.find(e => e.includes('ANTHROPIC_AUTH_TOKEN'));
            expect(tokenEnv).toContain('****');
            expect(tokenEnv).not.toContain('sk-abcd1234efgh5678');
        });

        test('--show-config should sanitize KEY values', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "API_KEY=myverysecretkey123"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const keyEnv = config.env.find(e => e.includes('API_KEY'));
            expect(keyEnv).toContain('****');
        });

        test('--show-config should not sanitize normal values', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "MY_VAR=normalvalue"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const normalEnv = config.env.find(e => e.includes('MY_VAR'));
            expect(normalEnv).toBe('MY_VAR=normalvalue');
        });
    });

    // ==============================================================================
    // 输入验证测试
    // ==============================================================================

    describe('Input Validation', () => {
        test('should reject invalid container name', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} -n "invalid name" --show-config`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should accept valid container name', () => {
            const output = execSync(
                `node ${BIN_PATH} -n "valid-name-123" --show-config`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.containerName).toBe('valid-name-123');
        });

        test('should reject env with invalid key', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} -e "123invalid=value" --show-config`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject env with dangerous characters', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} -e "VAR=value;rm -rf" --show-config`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });
    });

    // ==============================================================================
    // 配置合并测试
    // ==============================================================================

    describe('Configuration Merging', () => {
        test('command line should override defaults', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config --in custom-image --iv 2.0.0`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.imageName).toBe('custom-image');
            expect(config.imageVersion).toBe('2.0.0');
        });

        test('multiple env values should be merged', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "VAR1=value1" -e "VAR2=value2"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.env).toContain('VAR1=value1');
            expect(config.env).toContain('VAR2=value2');
        });

        test('multiple volumes should be merged', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -v "/tmp:/tmp" -v "/var:/var"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.volumes).toContain('/tmp:/tmp');
            expect(config.volumes).toContain('/var:/var');
        });

        test('--ss should set shell suffix', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -s codex --ss "-c"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.shell).toBe('codex');
            expect(config.shellSuffix).toBe(' -c');
        });

        test('run config should support shellSuffix', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-shellsuffix-'));
            const runConfigPath = path.join(tempDir, 'codex.json');
            fs.writeFileSync(runConfigPath, JSON.stringify({
                shell: 'codex',
                shellSuffix: 'resume --last'
            }, null, 4));

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r "${runConfigPath}"`,
                    { encoding: 'utf-8' }
                );
                const config = JSON.parse(output);
                expect(config.shell).toBe('codex');
                expect(config.shellSuffix).toBe(' resume --last');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('-- should override --ss suffix', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -s codex --ss "-c" -- resume --last`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.shellSuffix).toBe(' resume --last');
        });
    });

    // ==============================================================================
    // YOLO 模式测试
    // ==============================================================================

    describe('YOLO Mode', () => {
        test('-y c should set claude yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -y c`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('c');
            expect(config.shell).toContain('claude');
            expect(config.shell).toContain('--dangerously-skip-permissions');
        });

        test('-y gm should set gemini yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -y gm`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('gm');
            expect(config.shell).toBe('gemini --yolo');
        });

        test('-y cx should set codex yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -y cx`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('cx');
            expect(config.shell).toBe('codex --dangerously-bypass-approvals-and-sandbox');
        });

        test('-y oc should set opencode yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -y oc`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('oc');
            expect(config.shell).toBe('OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode');
        });
    });

    // ==============================================================================
    // 选项测试
    // ==============================================================================

    describe('Options', () => {
        test('--yes option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--yes');
        });

        test('--rm-on-exit option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--rm-on-exit');
        });

        test('--ss option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--ss');
        });

        test('--server option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--server');
        });

        test('--server-user and --server-pass options should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--server-user');
            expect(output).toContain('--server-pass');
        });

        test('--show-config should include server mode and port', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config --server 39001`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.server).toBe(true);
            expect(config.serverPort).toBe(39001);
        });

        test('--show-config should default server user to admin', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config --server`,
                {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        MANYOYO_SERVER_USER: '',
                        MANYOYO_SERVER_PASS: ''
                    }
                }
            );
            const config = JSON.parse(output);
            expect(config.serverUser).toBe('admin');
        });

        test('--show-config should include server auth config', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config --server --server-user webadmin --server-pass topsecret`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.serverUser).toBe('webadmin');
            expect(config.serverPass).toContain('****');
            expect(config.serverPass).not.toBe('topsecret');
        });

        test('quiet options should work', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -q tip -q cmd`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.quiet).toContain('tip');
            expect(config.quiet).toContain('cmd');
        });
    });
});
