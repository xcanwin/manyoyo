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

        test('invoked as my should display my in help usage', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-alias-'));
            const aliasPath = path.join(tempDir, 'my');
            fs.symlinkSync(BIN_PATH, aliasPath);
            try {
                const output = execSync(`"${aliasPath}" --help`, { encoding: 'utf-8' });
                expect(output).toContain('Usage: my [options]');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
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

        test('containerName should resolve {now} template from run config', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-contname-'));
            const runConfigPath = path.join(tempDir, 'opencode.json');
            fs.writeFileSync(runConfigPath, JSON.stringify({
                containerName: 'my-opencode-{now}'
            }, null, 4));

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r "${runConfigPath}"`,
                    { encoding: 'utf-8' }
                );
                const config = JSON.parse(output);
                expect(config.containerName).toMatch(/^my-opencode-\d{4}-\d{4}$/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
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
    // 初始化配置测试
    // ==============================================================================

    describe('Init Config', () => {
        test('--init-config claude should extract existing claude settings', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const claudeDir = path.join(tempHome, '.claude');
            const claudeSettingsPath = path.join(claudeDir, 'settings.json');

            fs.mkdirSync(claudeDir, { recursive: true });
            fs.writeFileSync(claudeSettingsPath, JSON.stringify({
                env: {
                    ANTHROPIC_AUTH_TOKEN: 'sk-claude-test-token',
                    ANTHROPIC_BASE_URL: 'https://llm.example.com',
                    ANTHROPIC_MODEL: 'claude-sonnet-4-5'
                }
            }, null, 4));

            try {
                execSync(`node "${BIN_PATH}" --init-config claude`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });

                const envFilePath = path.join(tempHome, '.manyoyo', 'env', 'claude.env');
                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'claude.json');

                expect(fs.existsSync(envFilePath)).toBe(true);
                expect(fs.existsSync(runFilePath)).toBe(true);

                const envContent = fs.readFileSync(envFilePath, 'utf-8');
                expect(envContent).toContain('ANTHROPIC_AUTH_TOKEN');
                expect(envContent).toContain('sk-claude-test-token');
                expect(envContent).toContain('ANTHROPIC_BASE_URL');

                const runConfig = JSON.parse(fs.readFileSync(runFilePath, 'utf-8'));
                expect(runConfig.containerName).toBe('my-claude-{now}');
                expect(runConfig.envFile).toEqual(['claude']);
                expect(runConfig.yolo).toBe('c');
                expect(runConfig.volumes).toContain(`${claudeDir}:/root/.claude`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--init-config codex should create template when source config is missing', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));

            try {
                execSync(`node "${BIN_PATH}" --init-config codex`, {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        HOME: tempHome,
                        OPENAI_API_KEY: '',
                        OPENAI_BASE_URL: '',
                        OPENAI_MODEL: ''
                    }
                });

                const envFilePath = path.join(tempHome, '.manyoyo', 'env', 'codex.env');
                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'codex.json');

                expect(fs.existsSync(envFilePath)).toBe(true);
                expect(fs.existsSync(runFilePath)).toBe(true);

                const envContent = fs.readFileSync(envFilePath, 'utf-8');
                expect(envContent).toContain('# export OPENAI_API_KEY=""');
                expect(envContent).toContain('# export OPENAI_BASE_URL=""');
                expect(envContent).toContain('# export OPENAI_MODEL=""');

                const runConfig = JSON.parse(fs.readFileSync(runFilePath, 'utf-8'));
                expect(runConfig.envFile).toEqual(['codex']);
                expect(runConfig.yolo).toBe('cx');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--init-config opencode should map local auth.json when it exists', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const opencodeConfigDir = path.join(tempHome, '.config', 'opencode');
            const opencodeLocalShareDir = path.join(tempHome, '.local', 'share', 'opencode');
            const opencodeConfigPath = path.join(opencodeConfigDir, 'opencode.json');
            const opencodeAuthPath = path.join(opencodeLocalShareDir, 'auth.json');

            fs.mkdirSync(opencodeConfigDir, { recursive: true });
            fs.mkdirSync(opencodeLocalShareDir, { recursive: true });
            fs.writeFileSync(opencodeConfigPath, JSON.stringify({
                provider: {
                    s: {
                        npm: '@ai-sdk/openai-compatible',
                        options: {
                            apiKey: 'sk-opencode-test',
                            baseURL: 'https://llm.example.com'
                        },
                        models: {
                            'gpt-5.2-codex': {}
                        }
                    }
                }
            }, null, 4));
            fs.writeFileSync(opencodeAuthPath, JSON.stringify({ token: 'demo' }, null, 4));

            try {
                execSync(`node "${BIN_PATH}" --init-config opencode`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });

                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'opencode.json');
                expect(fs.existsSync(runFilePath)).toBe(true);

                const runConfig = JSON.parse(fs.readFileSync(runFilePath, 'utf-8'));
                expect(runConfig.envFile).toEqual(['opencode']);
                expect(runConfig.yolo).toBe('oc');
                expect(runConfig.volumes).toContain(`${opencodeConfigPath}:/root/.config/opencode/opencode.json`);
                expect(runConfig.volumes).toContain(`${opencodeAuthPath}:/root/.local/share/opencode/auth.json`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--init-config should prompt and keep existing env/json when answering no', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const manyoyoEnvDir = path.join(tempHome, '.manyoyo', 'env');
            const manyoyoRunDir = path.join(tempHome, '.manyoyo', 'run');
            const targetEnvPath = path.join(manyoyoEnvDir, 'claude.env');
            const targetRunPath = path.join(manyoyoRunDir, 'claude.json');
            const originalEnvContent = 'export ORIGINAL_ONLY=1\n';
            const originalRunContent = '{\n    "keep": true\n}\n';

            fs.mkdirSync(manyoyoEnvDir, { recursive: true });
            fs.mkdirSync(manyoyoRunDir, { recursive: true });
            fs.writeFileSync(targetEnvPath, originalEnvContent);
            fs.writeFileSync(targetRunPath, originalRunContent);

            try {
                const output = execSync(`node "${BIN_PATH}" --init-config claude`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome },
                    input: 'n\nn\n'
                });

                expect(output).toContain(`${targetEnvPath} 已存在`);
                expect(output).toContain(`${targetRunPath} 已存在`);
                expect(fs.readFileSync(targetEnvPath, 'utf-8')).toBe(originalEnvContent);
                expect(fs.readFileSync(targetRunPath, 'utf-8')).toBe(originalRunContent);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
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

        test('--init-config option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--init-config');
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

        test('--show-config should parse server host and port', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config --server 0.0.0.0:39001`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.server).toBe(true);
            expect(config.serverHost).toBe('0.0.0.0');
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
