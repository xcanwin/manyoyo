/**
 * MANYOYO 单元测试
 * 运行: npm test
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { imageVersion: PACKAGE_IMAGE_VERSION } = require('../package.json');

const BIN_PATH = path.join(__dirname, '../bin/manyoyo.js');

function writeGlobalConfig(homeDir, configObj) {
    const manyoyoDir = path.join(homeDir, '.manyoyo');
    fs.mkdirSync(manyoyoDir, { recursive: true });
    fs.writeFileSync(
        path.join(manyoyoDir, 'manyoyo.json'),
        `${JSON.stringify(configObj, null, 4)}\n`
    );
}

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

        test('default imageVersion should match package imageVersion', () => {
            const output = execSync(`node ${BIN_PATH} --show-config`, { encoding: 'utf-8' });
            const config = JSON.parse(output);
            expect(config.imageVersion).toBe(PACKAGE_IMAGE_VERSION);
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
            const tokenEnv = config.env.ANTHROPIC_AUTH_TOKEN;
            expect(tokenEnv).toContain('****');
            expect(tokenEnv).not.toContain('sk-abcd1234efgh5678');
        });

        test('--show-config should sanitize KEY values', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "API_KEY=myverysecretkey123"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const keyEnv = config.env.API_KEY;
            expect(keyEnv).toContain('****');
        });

        test('--show-config should not sanitize normal values', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "MY_VAR=normalvalue"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const normalEnv = config.env.MY_VAR;
            expect(normalEnv).toBe('normalvalue');
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

        test('should accept absolute path for --ef', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-envfile-'));
            const envFilePath = path.join(tempDir, 'abs.env');
            fs.writeFileSync(envFilePath, 'export ABS_VAR=ok\n');

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config --ef "${envFilePath}"`,
                    { encoding: 'utf-8' }
                );
                const config = JSON.parse(output);
                expect(config.envFile).toContain(envFilePath);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('should reject non-absolute name for --ef', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} --show-config --ef myenv`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject relative path for --ef', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} --show-config --ef ./myenv.env`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should load run profile from manyoyo.json runs', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-run-'));
            writeGlobalConfig(tempHome, {
                runs: {
                    claude: {
                        shell: 'codex',
                        shellSuffix: 'resume --last'
                    }
                }
            });

            try {
                const output = execSync(`node ${BIN_PATH} --show-config -r claude`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const config = JSON.parse(output);
                expect(config.shell).toBe('codex');
                expect(config.shellSuffix).toBe(' resume --last');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('should reject absolute path for --run', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} --show-config -r /tmp/myconfig.json`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject relative path for --run', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} --show-config -r ./myconfig.json`, {
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
                `node ${BIN_PATH} --show-config --in custom-image --iv 2.0.0-common`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.imageName).toBe('custom-image');
            expect(config.imageVersion).toBe('2.0.0-common');
        });

        test('should reject imageVersion without suffix', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} --show-config --iv 2.0.0`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('multiple env values should be merged into env map', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -e "VAR1=value1" -e "VAR2=value2"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.env).toEqual(expect.objectContaining({
                VAR1: 'value1',
                VAR2: 'value2'
            }));
        });

        test('priority should be cli > runs > global > defaults', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-priority-'));
            writeGlobalConfig(tempHome, {
                shell: 'global-shell',
                runs: {
                    demo: {
                        shell: 'run-shell'
                    }
                }
            });

            try {
                const runOutput = execSync(`node ${BIN_PATH} --show-config -r demo`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const runConfig = JSON.parse(runOutput);
                expect(runConfig.shell).toBe('run-shell');

                const cliOutput = execSync(`node ${BIN_PATH} --show-config -r demo -s cli-shell`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const cliConfig = JSON.parse(cliOutput);
                expect(cliConfig.shell).toBe('cli-shell');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('json env map should merge with cli env and cli has higher priority', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-env-map-'));
            writeGlobalConfig(tempHome, {
                runs: {
                    envMap: {
                        env: {
                            VAR1: 'run-value',
                            VAR2: 'run-value-2'
                        }
                    }
                }
            });

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r envMap -e "VAR1=cli-value"`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.env).toEqual(expect.objectContaining({
                    VAR1: 'cli-value',
                    VAR2: 'run-value-2'
                }));
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('run config env array should be rejected', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-env-array-'));
            writeGlobalConfig(tempHome, {
                runs: {
                    envArray: {
                        env: ['VAR1=value1']
                    }
                }
            });

            try {
                expect(() => {
                    execSync(`node ${BIN_PATH} --show-config -r envArray`, {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome },
                        stdio: 'pipe'
                    });
                }).toThrow();
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
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

        test('multiple ports should be merged', () => {
            const output = execSync(
                `node ${BIN_PATH} --show-config -p "8080:80" -p "53:53/udp"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.ports).toContain('8080:80');
            expect(config.ports).toContain('53:53/udp');
        });

        test('ports should merge by global + runs + cli order', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ports-'));
            writeGlobalConfig(tempHome, {
                ports: ['7000:70'],
                runs: {
                    demo: {
                        ports: ['8000:80']
                    }
                }
            });

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r demo -p "9000:90"`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.ports).toEqual(['7000:70', '8000:80', '9000:90']);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--show-command should include publish args from --port', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-show-command-'));
            const fakeDockerPath = path.join(tempDir, 'docker');
            fs.writeFileSync(fakeDockerPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "ps" ]; then
  exit 0
fi
exit 0
`, { mode: 0o755 });

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-command -n port-test -p "8080:80" -p "127.0.0.1:8443:443"`,
                    {
                        encoding: 'utf-8',
                        env: {
                            ...process.env,
                            PATH: `${tempDir}:${process.env.PATH}`
                        }
                    }
                );
                expect(output).toContain('--publish 8080:80');
                expect(output).toContain('--publish 127.0.0.1:8443:443');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
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
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-shellsuffix-'));
            writeGlobalConfig(tempHome, {
                runs: {
                    codex: {
                        shell: 'codex',
                        shellSuffix: 'resume --last'
                    }
                }
            });

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r codex`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.shell).toBe('codex');
                expect(config.shellSuffix).toBe(' resume --last');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
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
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-contname-'));
            writeGlobalConfig(tempHome, {
                runs: {
                    opencode: {
                        containerName: 'my-opencode-{now}'
                    }
                }
            });

            try {
                const output = execSync(
                    `node ${BIN_PATH} --show-config -r opencode`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.containerName).toMatch(/^my-opencode-\d{4}-\d{4}$/);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
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

                const manyoyoConfigPath = path.join(tempHome, '.manyoyo', 'manyoyo.json');
                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'claude.json');
                const envFilePath = path.join(tempHome, '.manyoyo', 'env', 'claude.env');

                expect(fs.existsSync(manyoyoConfigPath)).toBe(true);
                expect(fs.existsSync(runFilePath)).toBe(false);
                expect(fs.existsSync(envFilePath)).toBe(false);

                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                const runConfig = manyoyoConfig.runs && manyoyoConfig.runs.claude;
                expect(runConfig.containerName).toBe('my-claude-{now}');
                expect(runConfig.yolo).toBe('c');
                expect(runConfig.envFile).toBeUndefined();
                expect(runConfig.env).toEqual(expect.objectContaining({
                    ANTHROPIC_AUTH_TOKEN: 'sk-claude-test-token',
                    ANTHROPIC_BASE_URL: 'https://llm.example.com',
                    ANTHROPIC_MODEL: 'claude-sonnet-4-5'
                }));
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

                const manyoyoConfigPath = path.join(tempHome, '.manyoyo', 'manyoyo.json');
                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'codex.json');
                const envFilePath = path.join(tempHome, '.manyoyo', 'env', 'codex.env');

                expect(fs.existsSync(manyoyoConfigPath)).toBe(true);
                expect(fs.existsSync(runFilePath)).toBe(false);
                expect(fs.existsSync(envFilePath)).toBe(false);

                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                const runConfig = manyoyoConfig.runs && manyoyoConfig.runs.codex;
                expect(runConfig.yolo).toBe('cx');
                expect(runConfig.envFile).toBeUndefined();
                expect(runConfig.env).toEqual(expect.objectContaining({
                    OPENAI_API_KEY: '',
                    OPENAI_BASE_URL: '',
                    OPENAI_MODEL: ''
                }));
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

                const manyoyoConfigPath = path.join(tempHome, '.manyoyo', 'manyoyo.json');
                const runFilePath = path.join(tempHome, '.manyoyo', 'run', 'opencode.json');
                expect(fs.existsSync(manyoyoConfigPath)).toBe(true);
                expect(fs.existsSync(runFilePath)).toBe(false);

                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                const runConfig = manyoyoConfig.runs && manyoyoConfig.runs.opencode;
                expect(runConfig.yolo).toBe('oc');
                expect(runConfig.envFile).toBeUndefined();
                expect(runConfig.env).toEqual(expect.objectContaining({
                    OPENAI_API_KEY: 'sk-opencode-test',
                    OPENAI_BASE_URL: 'https://llm.example.com',
                    OPENAI_MODEL: 'gpt-5.2-codex'
                }));
                expect(runConfig.volumes).toContain(`${opencodeConfigPath}:/root/.config/opencode/opencode.json`);
                expect(runConfig.volumes).toContain(`${opencodeAuthPath}:/root/.local/share/opencode/auth.json`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--init-config should prompt and keep existing json when answering no', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const manyoyoConfigPath = path.join(tempHome, '.manyoyo', 'manyoyo.json');
            writeGlobalConfig(tempHome, {
                runs: {
                    claude: {
                        keep: true
                    }
                }
            });

            try {
                const output = execSync(`node "${BIN_PATH}" --init-config claude`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome },
                    input: 'n\n'
                });

                expect(output).toContain('runs.claude 已存在');
                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                expect(manyoyoConfig.runs.claude).toEqual({ keep: true });
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

        test('--port option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--port');
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

        test('--update option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--update');
        });

        test('--update should invoke npm update when global install source is registry', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-update-'));
            const fakeNpmPath = path.join(tempDir, 'npm');
            const npmLogPath = path.join(tempDir, 'npm.log');
            const depPath = path.join(tempDir, 'dep-registry');

            fs.mkdirSync(depPath, { recursive: true });

            fs.writeFileSync(fakeNpmPath, `#!/bin/sh
echo "$@" >> "${npmLogPath}"
if [ "$1" = "ls" ]; then
cat <<EOF
{"dependencies":{"@xcanwin/manyoyo":{"path":"${depPath}"}}}
EOF
fi
exit 0
`, { mode: 0o755 });

            try {
                execSync(`"${process.execPath}" ${BIN_PATH} --update`, {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        PATH: `${tempDir}:${process.env.PATH}`,
                        HOME: tempDir
                    },
                    cwd: tempDir
                });

                const npmArgs = fs.readFileSync(npmLogPath, 'utf-8').trim().split('\n');
                expect(npmArgs.some(line => line.startsWith('ls -g @xcanwin/manyoyo'))).toBe(true);
                expect(npmArgs).toContain('update -g @xcanwin/manyoyo');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('--update should skip npm update when global install source is local file install', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-update-file-'));
            const fakeNpmPath = path.join(tempDir, 'npm');
            const npmLogPath = path.join(tempDir, 'npm.log');
            const depRealPath = path.join(tempDir, 'dep-real');
            const depLinkPath = path.join(tempDir, 'dep-link');
            fs.mkdirSync(depRealPath, { recursive: true });
            fs.symlinkSync(depRealPath, depLinkPath);

            fs.writeFileSync(fakeNpmPath, `#!/bin/sh
echo "$@" >> "${npmLogPath}"
if [ "$1" = "ls" ]; then
cat <<EOF
{"dependencies":{"@xcanwin/manyoyo":{"resolved":"file:/tmp/local-src","path":"${depLinkPath}"}}}
EOF
fi
exit 0
`, { mode: 0o755 });

            try {
                execSync(`"${process.execPath}" ${BIN_PATH} --update`, {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        PATH: `${tempDir}:${process.env.PATH}`,
                        HOME: tempDir
                    },
                    cwd: tempDir
                });

                const npmArgs = fs.readFileSync(npmLogPath, 'utf-8').trim().split('\n');
                expect(npmArgs.some(line => line.startsWith('ls -g @xcanwin/manyoyo'))).toBe(true);
                expect(npmArgs.some(line => line.startsWith('update -g @xcanwin/manyoyo'))).toBe(false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
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
