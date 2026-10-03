/**
 * MANYOYO 单元测试
 * 运行: npm test
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
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

function writeExecutable(filePath, content) {
    fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function runGit(repoPath, args, options = {}) {
    return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf-8',
        ...options
    });
}

function initGitRepo(repoPath) {
    runGit(repoPath, ['init']);
    runGit(repoPath, ['config', 'user.email', 'manyoyo-test@example.com']);
    runGit(repoPath, ['config', 'user.name', 'manyoyo-test']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# temp\n');
    runGit(repoPath, ['add', 'README.md']);
    runGit(repoPath, ['commit', '-m', 'init']);
}

describe('MANYOYO CLI', () => {
    // ==============================================================================
    // 基础命令测试
    // ==============================================================================

    describe('Basic Commands', () => {
        test('MANYOYO_COMMAND_NAME decides the command name shown (used by the installer wrappers for my / manyoyo)', () => {
            const run = name => execSync(`node ${BIN_PATH} --help`, { encoding: 'utf-8', env: { ...process.env, MANYOYO_COMMAND_NAME: name } });
            expect(run('my')).toContain('Usage: my [options]');
            // 不合法的值被忽略，退回按脚本名判断
            expect(run('bad name; rm')).toContain('Usage: manyoyo');
        });

        test('--help should display help message', () => {
            const output = execSync(`node ${BIN_PATH} --help`, { encoding: 'utf-8' });
            expect(output).toContain('Usage: manyoyo [options]');
            expect(output).toContain('MANYOYO');
        });

        describe('help output', () => {
            const help = args => execSync(`node ${BIN_PATH} ${args}`, { encoding: 'utf-8' });

            test('root help leads with the no-arg web entry, groups subcommands and uses Chinese wording', () => {
                const output = help('--help');
                expect(output).toContain('打开网页界面');
                expect(output).toContain('--headless');
                expect(output).toContain('--gui');
                ['日常:', '命令行运行:', '容器与镜像:', '网页服务与插件:'].forEach(title => expect(output).toContain(title));
                expect(output).toContain('显示帮助');
                expect(output).not.toContain('display help');
                expect(output).not.toContain('run/c.json');
                expect(output).not.toContain('1.7.4');
                expect(output).not.toContain('docker-cli-plugin');
                expect(output).not.toMatch(/^\s+plugin\b/m);
                expect(output).not.toMatch(/^\s+install\b/m);
            });

            test('root help keeps only a few common examples', () => {
                const output = help('--help');
                const examples = output.split('示例:')[1].split('\n').filter(line => line.trim().startsWith('manyoyo'));
                expect(examples.length).toBeLessThanOrEqual(5);
            });

            test('array options do not print (default: [])', () => {
                expect(help('run --help')).not.toContain('(default: [])');
                expect(help('build --help')).not.toContain('(default: [])');
                ['ps', 'serve', 'config show', 'playwright'].forEach(cmd => expect(help(`${cmd} --help`)).not.toContain('display help'));
            });

            test('image version examples follow package.json imageVersion', () => {
                expect(help('run --help')).toContain(PACKAGE_IMAGE_VERSION);
                expect(help('build --help')).toContain(PACKAGE_IMAGE_VERSION);
            });

            test('update and uninstall descriptions stay short', () => {
                const output = help('--help');
                expect(output).toContain('升级到最新版本');
                expect(output).toContain('卸载 MANYOYO（配置和数据默认保留）');
                expect(output).not.toContain('file 安装');
            });

            test('config command describes a container command, not docker run', () => {
                expect(help('config --help')).toContain('显示将执行的容器命令');
            });

            test('serve --list shows running instances (from ~/.manyoyo/run/serve/*.pid), says so when none, and refuses other serve flags', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-servelist-'));
            try {
                const run = args => require('child_process').spawnSync('node', [BIN_PATH, ...args], { encoding: 'utf-8', env: { ...process.env, HOME: tempHome } });
                expect(run(['serve', '--list']).stdout).toContain('没有正在运行的 serve。');
                const dir = path.join(tempHome, '.manyoyo', 'run', 'serve');
                fs.mkdirSync(dir, { recursive: true });
                // 起一个真正的 serve 形态进程（命令行含 serve），否则会被当成 pid 复用而不列出
                const sleeper = require('child_process').spawn('node', ['-e', 'setTimeout(() => {}, 30000)', 'serve', '-d'], { stdio: 'ignore' });
                fs.writeFileSync(path.join(dir, '127.0.0.1_4567.pid'), `${sleeper.pid}\n`);
                fs.writeFileSync(path.join(dir, '127.0.0.1_4568.pid'), '999999999\n'); // 已退出的不列出
                const listed = run(['serve', '--list']);
                expect(listed.status).toBe(0);
                expect(listed.stdout).toMatch(/监听地址\s+PID\s+版本\s+启动命令/);
                expect(listed.stdout).toContain('127.0.0.1:4567');
                expect(listed.stdout).toContain(String(sleeper.pid));
                sleeper.kill();
                expect(listed.stdout).not.toContain('4568');
                for (const extra of [['-d'], ['--stop'], ['--restart'], ['127.0.0.1:3000']]) {
                    const refused = run(['serve', '--list', ...extra]);
                    expect(refused.status).not.toBe(0);
                    expect(refused.stderr).toContain('--list');
                }
                expect(execSync(`node ${BIN_PATH} serve --help`, { encoding: 'utf-8' })).toContain('--list');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--post-install without a terminal on a headless machine installs only: no service, no questions, next steps printed', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-postinstall-'));
            try {
                const result = require('child_process').spawnSync('node', [BIN_PATH, '--post-install', '--headless'], { encoding: 'utf-8', input: '', env: { ...process.env, HOME: tempHome } });
                expect(result.status).toBe(0);
                expect(result.stdout).toContain('没有启动任何服务');
                expect(result.stdout).toContain('manyoyo setup');
                expect(fs.existsSync(path.join(tempHome, '.manyoyo', 'serve', 'app.json'))).toBe(false);
                expect(execSync(`node ${BIN_PATH} --help`, { encoding: 'utf-8' })).not.toContain('post-install');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('--post-install on a headless machine with a terminal asks how to configure; Enter would pick 1, here 3 starts nothing (real pty)', async () => {
            if (require('child_process').spawnSync('script', ['--version']).error) return; // 没有 script 命令就跳过
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-postinstall-tty-'));
            try {
                const output = await new Promise(resolve => {
                    const child = require('child_process').spawn('script', ['-qec', `node ${BIN_PATH} --post-install --headless`, '/dev/null'], { env: { ...process.env, HOME: tempHome }, stdio: ['pipe', 'pipe', 'pipe'] });
                    let text = '';
                    child.stdout.on('data', chunk => { text += chunk; if (text.includes('请选择 [默认选1]') && !child.stdin.writableEnded) child.stdin.write('3\n'); });
                    child.on('close', () => resolve(text));
                    setTimeout(() => child.kill('SIGKILL'), 15000);
                });
                expect(output).toContain('这台机器没有图形界面，怎么完成首次配置？');
                expect(output).toContain('1) 在终端里配置（推荐）');
                expect(output).toContain('请选择 [默认选1]');
                expect(output).toContain('没有启动任何服务');
                expect(fs.existsSync(path.join(tempHome, '.manyoyo', 'serve', 'app.json'))).toBe(false);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('install subcommand was removed', () => {
                const result = require('child_process').spawnSync('node', [BIN_PATH, 'install', 'docker-cli-plugin'], { encoding: 'utf-8' });
                expect(result.status).not.toBe(0);
                expect(result.stderr).toContain('unknown command');
            });

            test('podman --help prints usage and exits 0 without a private Podman', () => {
                const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-podman-help-'));
                try {
                    const result = require('child_process').spawnSync('node', [BIN_PATH, 'podman', '--help'], {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    });
                    expect(result.status).toBe(0);
                    expect(result.stdout).toContain('用法');
                } finally {
                    fs.rmSync(tempHome, { recursive: true, force: true });
                }
            });
        });

        test('no args should reuse the running local app and open a one-time login url', async () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-noargs-'));
            const binDir = path.join(tempHome, 'bin');
            const urlFile = path.join(tempHome, 'opened-url');
            fs.mkdirSync(binDir, { recursive: true });
            ['open', 'xdg-open'].forEach(name => writeExecutable(path.join(binDir, name), `#!/bin/sh\necho "$1" > "${urlFile}"\n`));
            // 复用前启动器会 HTTP 探测 X-Manyoyo-Serve 标记，裸 TCP 端口不算 manyoyo serve
            const server = require('http').createServer((req, res) => { res.setHeader('X-Manyoyo-Serve', '1'); res.writeHead(401); res.end('{}'); }).listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const { port } = server.address();
            const serveDir = path.join(tempHome, '.manyoyo', 'serve');
            fs.mkdirSync(serveDir, { recursive: true });
            fs.writeFileSync(path.join(serveDir, 'app.json'), JSON.stringify({ host: '127.0.0.1', port, pid: process.pid }));
            try {
                const result = await new Promise(resolve => {
                    require('child_process').execFile('node', [BIN_PATH], {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome, PATH: `${binDir}:${process.env.PATH}`, MANYOYO_HEADLESS: '0' }
                    }, (error, stdout) => resolve({ error, stdout }));
                });
                expect(result.error).toBeNull();
                expect(result.stdout).toContain(`已复用运行中的服务: http://127.0.0.1:${port}`);
                expect(result.stdout).not.toContain('token=');
                expect(fs.readFileSync(urlFile, 'utf-8').trim()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/auth/login\\?token=[0-9a-f]{64}$`));
                const tokenDir = path.join(serveDir, 'login-tokens');
                expect(fs.readdirSync(tokenDir)).toHaveLength(1);
                expect(fs.statSync(tokenDir).mode & 0o777).toBe(0o700);
            } finally {
                server.close();
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('no args headless (--headless): reuses the app but opens no browser, issues no token, prints ssh -L / stop / setup hints', async () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-headless-'));
            const binDir = path.join(tempHome, 'bin');
            const urlFile = path.join(tempHome, 'opened-url');
            fs.mkdirSync(binDir, { recursive: true });
            ['open', 'xdg-open'].forEach(name => writeExecutable(path.join(binDir, name), `#!/bin/sh\necho "$1" > "${urlFile}"\n`));
            const server = require('http').createServer((req, res) => { res.setHeader('X-Manyoyo-Serve', '1'); res.writeHead(401); res.end('{}'); }).listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            const { port } = server.address();
            const serveDir = path.join(tempHome, '.manyoyo', 'serve');
            fs.mkdirSync(serveDir, { recursive: true });
            fs.writeFileSync(path.join(serveDir, 'app.json'), JSON.stringify({ host: '127.0.0.1', port, pid: process.pid }));
            try {
                const result = await new Promise(resolve => {
                    require('child_process').execFile('node', [BIN_PATH, '--headless'], {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome, PATH: `${binDir}:${process.env.PATH}`, MANYOYO_HEADLESS: '0' }
                    }, (error, stdout) => resolve({ error, stdout }));
                });
                expect(result.error).toBeNull();
                expect(result.stdout).toContain(`ssh -L ${port}:127.0.0.1:${port}`);
                expect(result.stdout).toContain(`manyoyo serve 127.0.0.1:${port} --stop`);
                expect(result.stdout).toContain('manyoyo setup');
                expect(fs.existsSync(urlFile)).toBe(false);
                expect(fs.existsSync(path.join(serveDir, 'login-tokens'))).toBe(false);
            } finally {
                server.close();
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('setup without a terminal does not hang: explains the alternatives and exits 1', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-setup-nontty-'));
            try {
                const result = require('child_process').spawnSync('node', [BIN_PATH, 'setup'], {
                    encoding: 'utf-8', input: '', timeout: 20000, env: { ...process.env, HOME: tempHome }
                });
                expect(result.status).toBe(1);
                expect(result.stdout).toContain('交互式终端');
                expect(fs.existsSync(path.join(tempHome, '.manyoyo', 'manyoyo.json'))).toBe(false);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
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
            expect(output).toContain('manyoyo run -y c');
        });

        test('serve --help should include detach stop and restart option', () => {
            const output = execSync(`node ${BIN_PATH} serve --help`, { encoding: 'utf-8' });
            expect(output).toContain('-d, --detach');
            expect(output).toContain('--stop');
            expect(output).toContain('--restart');
        });

        test('--version should display version', () => {
            const output = execSync(`node ${BIN_PATH} --version`, { encoding: 'utf-8' });
            expect(output).toMatch(/^\d+\.\d+\.\d+/);
        });

        test('-v should display version', () => {
            const output = execSync(`node ${BIN_PATH} -v`, { encoding: 'utf-8' });
            expect(output).toMatch(/^\d+\.\d+\.\d+/);
        });

        test('-V is an alias of -v', () => {
            expect(execSync(`node ${BIN_PATH} -V`, { encoding: 'utf-8' })).toMatch(/^\d+\.\d+\.\d+/);
        });

        test('default imageName is the prebuilt ghcr image, and build tags with the same name', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-default-image-'));
            try {
                const env = { ...process.env, HOME: tempHome };
                const config = JSON.parse(execSync(`node ${BIN_PATH} config show`, { encoding: 'utf-8', env }));
                expect(config.imageName).toBe('ghcr.io/xcanwin/manyoyo');
                expect(fs.readFileSync(BIN_PATH, 'utf-8')).not.toContain('localhost/xcanwin/manyoyo"');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('config show should output valid JSON', () => {
            const output = execSync(`node ${BIN_PATH} config show`, { encoding: 'utf-8' });
            const config = JSON.parse(output);
            expect(config).toHaveProperty('hostPath');
            expect(config).toHaveProperty('containerName');
            expect(config).toHaveProperty('imageName');
            expect(config).toHaveProperty('imageVersion');
        });

        test('default imageVersion should match package imageVersion', () => {
            const output = execSync(`node ${BIN_PATH} config show`, { encoding: 'utf-8' });
            const config = JSON.parse(output);
            expect(config.imageVersion).toBe(PACKAGE_IMAGE_VERSION);
        });
    });

    // ==============================================================================
    // 敏感信息脱敏测试
    // ==============================================================================

    describe('Sensitive Data Sanitization', () => {
        test('config show should sanitize TOKEN values', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -e "ANTHROPIC_AUTH_TOKEN=sk-abcd1234efgh5678"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const tokenEnv = config.env.ANTHROPIC_AUTH_TOKEN;
            expect(tokenEnv).toContain('****');
            expect(tokenEnv).not.toContain('sk-abcd1234efgh5678');
        });

        test('config show should sanitize KEY values', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -e "API_KEY=myverysecretkey123"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            const keyEnv = config.env.API_KEY;
            expect(keyEnv).toContain('****');
        });

        test('config show should not sanitize normal values', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -e "MY_VAR=normalvalue"`,
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
                execSync(`node ${BIN_PATH} config show -n "invalid name"`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should accept valid container name', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -n "valid-name-123"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.containerName).toBe('valid-name-123');
        });

        test('should reject env with invalid key', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} config show -e "123invalid=value"`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject env with dangerous characters', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} config show -e "VAR=value;rm -rf"`, {
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
                    `node ${BIN_PATH} config show --ef "${envFilePath}"`,
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
                execSync(`node ${BIN_PATH} config show --ef myenv`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject relative path for --ef', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} config show --ef ./myenv.env`, {
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
                const output = execSync(`node ${BIN_PATH} config show -r claude`, {
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
                execSync(`node ${BIN_PATH} config show -r /tmp/myconfig.json`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('should reject relative path for --run', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} config show -r ./myconfig.json`, {
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
                `node ${BIN_PATH} config show --in custom-image --iv 2.0.0-common`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.imageName).toBe('custom-image');
            expect(config.imageVersion).toBe('2.0.0-common');
        });

        test('should reject imageVersion without suffix', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} config show --iv 2.0.0`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('multiple env values should be merged into env map', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -e "VAR1=value1" -e "VAR2=value2"`,
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
                const runOutput = execSync(`node ${BIN_PATH} config show -r demo`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const runConfig = JSON.parse(runOutput);
                expect(runConfig.shell).toBe('run-shell');

                const cliOutput = execSync(`node ${BIN_PATH} config show -r demo -s cli-shell`, {
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
                    `node ${BIN_PATH} config show -r envMap -e "VAR1=cli-value"`,
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

        test('first config should merge by global + runs for env/envFile/shell', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-merge-'));
            const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-env-'));
            const globalFirstEnvFile = path.join(envDir, 'global-first.env');
            const runFirstEnvFile = path.join(envDir, 'run-first.env');
            fs.writeFileSync(globalFirstEnvFile, 'GLOBAL_FIRST=1\n');
            fs.writeFileSync(runFirstEnvFile, 'RUN_FIRST=1\n');

            writeGlobalConfig(tempHome, {
                first: {
                    env: {
                        FIRST_A: 'global-a',
                        FIRST_B: 'global-b'
                    },
                    envFile: [globalFirstEnvFile],
                    shellPrefix: 'GLOBAL=1',
                    shell: 'global-first',
                    shellSuffix: '--init'
                },
                runs: {
                    demo: {
                        first: {
                            env: {
                                FIRST_A: 'run-a'
                            },
                            envFile: [runFirstEnvFile],
                            shell: 'run-first'
                        }
                    }
                }
            });

            try {
                const output = execSync(`node ${BIN_PATH} config show -r demo`, {
                    encoding: 'utf-8',
                    env: { ...process.env, HOME: tempHome }
                });
                const config = JSON.parse(output);
                expect(config.first.env).toEqual(expect.objectContaining({
                    FIRST_A: 'run-a',
                    FIRST_B: 'global-b'
                }));
                expect(config.first.envFile).toEqual([globalFirstEnvFile, runFirstEnvFile]);
                expect(config.first.shellPrefix).toBe('GLOBAL=1');
                expect(config.first.shell).toBe('run-first');
                expect(config.first.shellSuffix).toBe(' --init');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
                fs.rmSync(envDir, { recursive: true, force: true });
            }
        });

        test('first config should allow cli override for env/envFile/shell', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-cli-'));
            const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-cli-env-'));
            const globalFirstEnvFile = path.join(envDir, 'global-first.env');
            const runFirstEnvFile = path.join(envDir, 'run-first.env');
            const cliFirstEnvFile = path.join(envDir, 'cli-first.env');
            fs.writeFileSync(globalFirstEnvFile, 'GLOBAL_FIRST=1\n');
            fs.writeFileSync(runFirstEnvFile, 'RUN_FIRST=1\n');
            fs.writeFileSync(cliFirstEnvFile, 'CLI_FIRST=1\n');

            writeGlobalConfig(tempHome, {
                first: {
                    env: {
                        FIRST_A: 'global-a',
                        FIRST_B: 'global-b'
                    },
                    envFile: [globalFirstEnvFile],
                    shellPrefix: 'GLOBAL=1',
                    shell: 'global-first',
                    shellSuffix: '--global'
                },
                runs: {
                    demo: {
                        first: {
                            env: {
                                FIRST_A: 'run-a'
                            },
                            envFile: [runFirstEnvFile],
                            shell: 'run-first'
                        }
                    }
                }
            });

            try {
                const output = execSync(
                    `node ${BIN_PATH} config show -r demo --first-env "FIRST_A=cli-a" --first-env "FIRST_C=cli-c" --first-env-file "${cliFirstEnvFile}" --first-shell-prefix "CLI=1" --first-shell "cli-first" --first-shell-suffix "--cli"`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.first.env).toEqual(expect.objectContaining({
                    FIRST_A: 'cli-a',
                    FIRST_B: 'global-b',
                    FIRST_C: 'cli-c'
                }));
                expect(config.first.envFile).toEqual([globalFirstEnvFile, runFirstEnvFile, cliFirstEnvFile]);
                expect(config.first.shellPrefix).toBe('CLI=1');
                expect(config.first.shell).toBe('cli-first');
                expect(config.first.shellSuffix).toBe(' --cli');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
                fs.rmSync(envDir, { recursive: true, force: true });
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
                    execSync(`node ${BIN_PATH} config show -r envArray`, {
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
                `node ${BIN_PATH} config show -v "/tmp:/tmp" -v "/var:/var"`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.volumes).toContain('/tmp:/tmp');
            expect(config.volumes).toContain('/var:/var');
        });

        test('volumes should expand tilde and $HOME on host side', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-volumes-home-'));

            try {
                const output = execSync(
                    `node ${BIN_PATH} config show -v "~/demo:/workspace/demo" -v '$HOME/cache:/workspace/cache'`,
                    {
                        encoding: 'utf-8',
                        env: { ...process.env, HOME: tempHome }
                    }
                );
                const config = JSON.parse(output);
                expect(config.volumes).toContain(`${path.join(tempHome, 'demo')}:/workspace/demo`);
                expect(config.volumes).toContain(`${path.join(tempHome, 'cache')}:/workspace/cache`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('multiple ports should be merged', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -p "8080:80" -p "53:53/udp"`,
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
                    `node ${BIN_PATH} config show -r demo -p "9000:90"`,
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

        test('mirrors: config show lists them, config command injects npm/pip env, bad values are rejected', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-mirrors-'));
            const fakeDocker = path.join(tempHome, 'docker');
            fs.writeFileSync(fakeDocker, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Docker version 26.0.0"; fi\nexit 0\n', { mode: 0o755 });
            const env = { ...process.env, HOME: tempHome, PATH: `${tempHome}:${process.env.PATH}` };
            try {
                writeGlobalConfig(tempHome, { mirrors: { npm: 'https://registry.npmmirror.com/', pip: 'https://pypi.tuna.tsinghua.edu.cn/simple', apt: 'https://mirrors.ustc.edu.cn' } });
                const shown = JSON.parse(execSync(`node ${BIN_PATH} config show`, { encoding: 'utf-8', env }));
                expect(shown.mirrors).toEqual({ apt: 'https://mirrors.ustc.edu.cn', npm: 'https://registry.npmmirror.com/', pip: 'https://pypi.tuna.tsinghua.edu.cn/simple' });
                const command = execSync(`node ${BIN_PATH} config command -n mirror-test`, { encoding: 'utf-8', env });
                expect(command).toContain('NPM_CONFIG_REGISTRY=https://registry.npmmirror.com/');
                expect(command).toContain('PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple');

                writeGlobalConfig(tempHome, { mirrors: { npm: 'ftp://nope' } });
                expect(() => execSync(`node ${BIN_PATH} config show`, { encoding: 'utf-8', env, stdio: 'pipe' })).toThrow(/mirrors\.npm/);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('config command should include publish args from --port', () => {
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
                    `node ${BIN_PATH} config command -n port-test -p "8080:80" -p "127.0.0.1:8443:443"`,
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

        test('config show --wt should infer and create project worktrees root from main repo', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-worktrees-main-'));
            const repoDir = path.join(tempDir, 'demo');
            fs.mkdirSync(repoDir, { recursive: true });
            initGitRepo(repoDir);

            try {
                const output = execSync(`node ${BIN_PATH} config show --wt`, {
                    encoding: 'utf-8',
                    cwd: repoDir
                });
                const config = JSON.parse(output);
                const expectedRoot = path.join(tempDir, 'worktrees', 'demo');

                expect(config.worktrees).toBe(true);
                expect(config.worktreesRoot).toBe(expectedRoot);
                expect(config.worktreeRepoRoot).toBe(repoDir);
                expect(config.worktreeMainRepoRoot).toBe(repoDir);
                expect(config.volumes).toContain(`${expectedRoot}:${expectedRoot}`);
                expect(fs.existsSync(expectedRoot)).toBe(true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('config show --wtr should override worktrees root and implicitly enable worktrees', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-worktrees-root-'));
            const repoDir = path.join(tempDir, 'demo');
            const customRoot = path.join(tempDir, 'custom-worktrees-root');
            fs.mkdirSync(repoDir, { recursive: true });
            initGitRepo(repoDir);

            try {
                const output = execSync(`node ${BIN_PATH} config show --wtr "${customRoot}"`, {
                    encoding: 'utf-8',
                    cwd: repoDir
                });
                const config = JSON.parse(output);

                expect(config.worktrees).toBe(true);
                expect(config.worktreesRoot).toBe(customRoot);
                expect(config.volumes).toContain(`${customRoot}:${customRoot}`);
                expect(fs.existsSync(customRoot)).toBe(true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('config show --worktrees should mount main repo and project worktrees root from a git worktree', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-worktrees-branch-'));
            const repoDir = path.join(tempDir, 'demo');
            const worktreesRoot = path.join(tempDir, 'worktrees', 'demo');
            const worktreeDir = path.join(worktreesRoot, 'feature');
            fs.mkdirSync(repoDir, { recursive: true });
            initGitRepo(repoDir);
            runGit(repoDir, ['branch', 'feature']);
            fs.mkdirSync(worktreesRoot, { recursive: true });
            runGit(repoDir, ['worktree', 'add', worktreeDir, 'feature']);

            try {
                const output = execSync(`node ${BIN_PATH} config show --worktrees`, {
                    encoding: 'utf-8',
                    cwd: worktreeDir
                });
                const config = JSON.parse(output);

                expect(config.worktrees).toBe(true);
                expect(config.worktreesRoot).toBe(worktreesRoot);
                expect(config.worktreeRepoRoot).toBe(worktreeDir);
                expect(config.worktreeMainRepoRoot).toBe(repoDir);
                expect(config.volumes).toContain(`${repoDir}:${repoDir}`);
                expect(config.volumes).toContain(`${worktreesRoot}:${worktreesRoot}`);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('config command --wt should include inferred worktree mounts', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-worktrees-command-'));
            const repoDir = path.join(tempDir, 'demo');
            const worktreesRoot = path.join(tempDir, 'worktrees', 'demo');
            const worktreeDir = path.join(worktreesRoot, 'feature');
            const fakeDockerPath = path.join(tempDir, 'docker');
            fs.mkdirSync(repoDir, { recursive: true });
            initGitRepo(repoDir);
            runGit(repoDir, ['branch', 'feature']);
            fs.mkdirSync(worktreesRoot, { recursive: true });
            runGit(repoDir, ['worktree', 'add', worktreeDir, 'feature']);
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
                const output = execSync(`node ${BIN_PATH} config command --wt`, {
                    encoding: 'utf-8',
                    cwd: worktreeDir,
                    env: {
                        ...process.env,
                        PATH: `${tempDir}:${process.env.PATH}`
                    }
                });

                expect(output).toContain(`--volume ${repoDir}:${repoDir}`);
                expect(output).toContain(`--volume ${worktreesRoot}:${worktreesRoot}`);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('config show --wt should reject non-git directories', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-worktrees-non-git-'));

            try {
                expect(() => {
                    execSync(`node ${BIN_PATH} config show --wt`, {
                        encoding: 'utf-8',
                        cwd: tempDir,
                        stdio: 'pipe'
                    });
                }).toThrow();
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('--ss should set shell suffix', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -s codex --ss "-c"`,
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
                    `node ${BIN_PATH} config show -r codex`,
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
                `node ${BIN_PATH} config show -s codex --ss "-c" -- resume --last`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.shellSuffix).toBe(' resume --last');
        });

        test('config show should reject extra positional args without --', () => {
            expect(() => {
                execSync(
                    `node ${BIN_PATH} config show -s codex resume last`,
                    { encoding: 'utf-8', stdio: 'pipe' }
                );
            }).toThrow(/存在多余位置参数/);
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
                    `node ${BIN_PATH} config show -r opencode`,
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
                `node ${BIN_PATH} config show -y c`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('c');
            expect(config.shell).toContain('claude');
            expect(config.shell).toContain('--dangerously-skip-permissions');
        });

        test('-y gm should set gemini yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -y gm`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('gm');
            expect(config.shell).toBe('gemini --yolo');
        });

        test('-y cx should set codex yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -y cx`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.yolo).toBe('cx');
            expect(config.shell).toBe('codex --dangerously-bypass-approvals-and-sandbox');
        });

        test('-y oc should set opencode yolo mode', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -y oc`,
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
        test('init claude should extract existing claude settings', () => {
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
                execSync(`node "${BIN_PATH}" init claude`, {
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

        test('init codex should create template when source config is missing', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));

            try {
                execSync(`node "${BIN_PATH}" init codex`, {
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

        test('init codex should read openai_base_url from config.toml', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const codexDir = path.join(tempHome, '.codex');
            const configPath = path.join(codexDir, 'config.toml');

            fs.mkdirSync(codexDir, { recursive: true });
            fs.writeFileSync(configPath, [
                'openai_base_url = "https://chatgpt.com/backend-api/codex"',
                'model = "gpt-5.4"'
            ].join('\n'));

            try {
                execSync(`node "${BIN_PATH}" init codex`, {
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
                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                const runConfig = manyoyoConfig.runs && manyoyoConfig.runs.codex;

                expect(runConfig.env).toEqual(expect.objectContaining({
                    OPENAI_API_KEY: '',
                    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
                    OPENAI_MODEL: 'gpt-5.4'
                }));
                expect(runConfig.volumes).toContain(`${codexDir}:/root/.codex`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('init codex should ignore legacy model_providers base_url in config.toml', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-init-'));
            const codexDir = path.join(tempHome, '.codex');
            const configPath = path.join(codexDir, 'config.toml');

            fs.mkdirSync(codexDir, { recursive: true });
            fs.writeFileSync(configPath, [
                'model_provider = "openai_api"',
                'model = "gpt-5.4"',
                '[model_providers.openai_api]',
                'name = "OpenAI_API"',
                'base_url = "https://legacy.example.com/codex"',
                'wire_api = "responses"',
                'requires_openai_auth = true'
            ].join('\n'));

            try {
                execSync(`node "${BIN_PATH}" init codex`, {
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
                const manyoyoConfig = JSON.parse(fs.readFileSync(manyoyoConfigPath, 'utf-8'));
                const runConfig = manyoyoConfig.runs && manyoyoConfig.runs.codex;

                expect(runConfig.env).toEqual(expect.objectContaining({
                    OPENAI_API_KEY: '',
                    OPENAI_BASE_URL: '',
                    OPENAI_MODEL: 'gpt-5.4'
                }));
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('init opencode should map local auth.json when it exists', () => {
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
                execSync(`node "${BIN_PATH}" init opencode`, {
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

        test('init should prompt and keep existing json when answering no', () => {
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
                const output = execSync(`node "${BIN_PATH}" init claude`, {
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
    // first 预执行测试
    // ==============================================================================

    describe('First Bootstrap', () => {
        test('new container should execute first command before regular command', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-run-'));
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-home-'));
            const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-env-'));
            const statePath = path.join(tempDir, 'state.txt');
            const dockerLogPath = path.join(tempDir, 'docker.log');
            const fakeDockerPath = path.join(tempDir, 'docker');
            const firstEnvFilePath = path.join(envDir, 'first.env');
            fs.writeFileSync(firstEnvFilePath, 'FROM_FILE=file-first\n');

            writeExecutable(fakeDockerPath, `#!/bin/sh
echo "$@" >> "${dockerLogPath}"
STATE_FILE="${statePath}"
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  fi
  exit 0
fi
if [ "$1" = "run" ]; then
  shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "--name" ]; then
      shift
      echo "$1" > "$STATE_FILE"
      break
    fi
    shift
  done
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
  if [ "$3" = "{{.State.Status}}" ]; then
    echo "running"
    exit 0
  fi
  if [ "$3" = "{{index .Config.Labels \\"manyoyo.default_cmd\\"}}" ]; then
    echo "regular-cmd"
    exit 0
  fi
fi
if [ "$1" = "exec" ]; then
  exit 0
fi
if [ "$1" = "rm" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi
exit 0
`);

            writeGlobalConfig(tempHome, {
                runs: {
                    demo: {
                        containerName: 'first-new-test',
                        shell: 'regular-cmd',
                        first: {
                            shell: 'first-cmd',
                            env: {
                                FIRST_ONLY: '1'
                            },
                            envFile: [firstEnvFilePath]
                        }
                    }
                }
            });

            try {
                execSync(`node ${BIN_PATH} run -r demo`, {
                    encoding: 'utf-8',
                    input: '\n',
                    env: {
                        ...process.env,
                        HOME: tempHome,
                        PATH: `${tempDir}:${process.env.PATH}`
                    }
                });

                const dockerArgs = fs.readFileSync(dockerLogPath, 'utf-8').trim().split('\n').filter(Boolean);
                const firstExecIndex = dockerArgs.findIndex(line =>
                    line.includes('exec --env FROM_FILE=file-first --env FIRST_ONLY=1 first-new-test /bin/bash -c first-cmd')
                );
                const regularExecIndex = dockerArgs.findIndex(line =>
                    line.includes('exec -it first-new-test /bin/bash -c regular-cmd')
                );

                expect(firstExecIndex).toBeGreaterThan(-1);
                expect(regularExecIndex).toBeGreaterThan(-1);
                expect(firstExecIndex).toBeLessThan(regularExecIndex);
                expect(dockerArgs[regularExecIndex]).not.toContain('FIRST_ONLY=1');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
                fs.rmSync(tempHome, { recursive: true, force: true });
                fs.rmSync(envDir, { recursive: true, force: true });
            }
        });

        test('existing container should skip first command', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-existing-'));
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-existing-home-'));
            const statePath = path.join(tempDir, 'state.txt');
            const dockerLogPath = path.join(tempDir, 'docker.log');
            const fakeDockerPath = path.join(tempDir, 'docker');
            fs.writeFileSync(statePath, 'existing-test\n');

            writeExecutable(fakeDockerPath, `#!/bin/sh
echo "$@" >> "${dockerLogPath}"
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  cat "${statePath}"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
  if [ "$3" = "{{.State.Status}}" ]; then
    echo "running"
    exit 0
  fi
  if [ "$3" = "{{index .Config.Labels \\"manyoyo.default_cmd\\"}}" ]; then
    echo "regular-existing-cmd"
    exit 0
  fi
fi
if [ "$1" = "exec" ]; then
  exit 0
fi
if [ "$1" = "start" ]; then
  exit 0
fi
exit 0
`);

            writeGlobalConfig(tempHome, {
                runs: {
                    demo: {
                        containerName: 'existing-test',
                        shell: 'regular-existing-cmd',
                        first: {
                            shell: 'first-should-not-run',
                            env: {
                                FIRST_ONLY: '1'
                            }
                        }
                    }
                }
            });

            try {
                execSync(`node ${BIN_PATH} run -r demo`, {
                    encoding: 'utf-8',
                    input: '\n',
                    env: {
                        ...process.env,
                        HOME: tempHome,
                        PATH: `${tempDir}:${process.env.PATH}`
                    }
                });

                const dockerArgs = fs.readFileSync(dockerLogPath, 'utf-8').trim().split('\n').filter(Boolean);
                expect(dockerArgs.some(line => line.includes('first-should-not-run'))).toBe(false);
                expect(dockerArgs.some(line => line.includes('exec -it existing-test /bin/bash -c regular-existing-cmd'))).toBe(true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('should stop when first command fails', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-fail-'));
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-fail-home-'));
            const statePath = path.join(tempDir, 'state.txt');
            const dockerLogPath = path.join(tempDir, 'docker.log');
            const fakeDockerPath = path.join(tempDir, 'docker');

            writeExecutable(fakeDockerPath, `#!/bin/sh
echo "$@" >> "${dockerLogPath}"
STATE_FILE="${statePath}"
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  fi
  exit 0
fi
if [ "$1" = "run" ]; then
  shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "--name" ]; then
      shift
      echo "$1" > "$STATE_FILE"
      break
    fi
    shift
  done
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ] && [ "$3" = "{{.State.Status}}" ]; then
  echo "running"
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *"first-fail"*)
      exit 12
      ;;
  esac
  exit 0
fi
if [ "$1" = "rm" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi
exit 0
`);

            writeGlobalConfig(tempHome, {
                runs: {
                    demo: {
                        containerName: 'first-fail-test',
                        shell: 'regular-after-fail',
                        first: {
                            shell: 'first-fail'
                        }
                    }
                }
            });

            try {
                expect(() => {
                    execSync(`node ${BIN_PATH} run -r demo`, {
                        encoding: 'utf-8',
                        input: '\n',
                        stdio: 'pipe',
                        env: {
                            ...process.env,
                            HOME: tempHome,
                            PATH: `${tempDir}:${process.env.PATH}`
                        }
                    });
                }).toThrow();

                const dockerArgs = fs.readFileSync(dockerLogPath, 'utf-8').trim().split('\n').filter(Boolean);
                expect(dockerArgs.some(line =>
                    line.includes('exec first-fail-test /bin/bash -c first-fail')
                )).toBe(true);
                expect(dockerArgs.some(line =>
                    line.includes('exec -it first-fail-test /bin/bash -c regular-after-fail')
                )).toBe(false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });
    });

    // ==============================================================================
    // 容器运行时诊断测试
    // ==============================================================================

    describe('Container Runtime Diagnostics', () => {
        test('run should suggest podman machine start when Podman socket is unavailable through docker command', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-runtime-diag-'));
            const fakeDockerPath = path.join(tempDir, 'docker');

            writeExecutable(fakeDockerPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "docker version 5.8.0"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  echo 'Cannot connect to Podman. Please verify your connection to the Linux system using \`podman system connection list\`, or try \`podman machine init\` and \`podman machine start\` to manage a new Linux VM' >&2
  echo 'Error: unable to connect to Podman socket: failed to connect: dial tcp 127.0.0.1:58474: connect: connection refused' >&2
  exit 125
fi
exit 0
`);

            try {
                let stderr = '';
                try {
                    execSync(`node ${BIN_PATH} run -n runtime-diag -x true`, {
                        encoding: 'utf-8',
                        stdio: 'pipe',
                        env: {
                            ...process.env,
                            PATH: `${tempDir}:${process.env.PATH}`
                        }
                    });
                } catch (e) {
                    stderr = e.stderr;
                }
                expect(stderr).toContain('Command failed: docker ps -a --format {{.Names}}');
                expect(stderr).toContain('当前 docker 命令正在连接 Podman machine，但连接不可用');
                expect(stderr).toContain('podman machine start');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('Container Runtime Selection', () => {
        const runWithHome = (homeDir, args) => require('child_process').spawnSync('node', [BIN_PATH, ...args], {
            encoding: 'utf-8',
            env: { ...process.env, HOME: homeDir }
        });

        test('config show reports containerRuntime, defaulting to auto', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-runtime-show-'));
            try {
                expect(JSON.parse(runWithHome(tempHome, ['config', 'show']).stdout).containerRuntime).toBe('auto');
                writeGlobalConfig(tempHome, { containerRuntime: 'podman' });
                expect(JSON.parse(runWithHome(tempHome, ['config', 'show']).stdout).containerRuntime).toBe('podman');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('doctor --json reports a configured runtime as source config', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-runtime-config-'));
            try {
                writeGlobalConfig(tempHome, { containerRuntime: 'podman' });
                const report = JSON.parse(runWithHome(tempHome, ['doctor', '--json']).stdout);
                expect(report.runtimeCommand).toBe('podman');
                expect(report.runtimeSource).toBe('config');
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('doctor without -r checks the only configured run; top-level -V prints the version', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-doctor-run-'));
            try {
                writeGlobalConfig(tempHome, { containerRuntime: 'podman', runs: { claude: { yolo: 'c' } } });
                const report = JSON.parse(runWithHome(tempHome, ['doctor', '--json']).stdout);
                expect(report.checks.find(check => check.code === 'AGENT_CONFIGURED').status).toBe('ok');
                expect(runWithHome(tempHome, ['-V']).stdout.trim()).toBe(runWithHome(tempHome, ['-v']).stdout.trim());
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });

        test('private podman is selected and receives its isolated env only', () => {
            const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-runtime-private-'));
            try {
                const privateBin = path.join(tempHome, '.manyoyo', 'runtime', 'podman', 'bin', 'podman');
                fs.mkdirSync(path.dirname(privateBin), { recursive: true });
                writeExecutable(privateBin, '#!/bin/sh\necho "conf=$CONTAINERS_CONF xdg=$XDG_DATA_HOME"\n');
                const report = JSON.parse(runWithHome(tempHome, ['doctor', '--json']).stdout);

                expect(report.runtimeCommand).toBe(privateBin);
                expect(report.runtimeSource).toBe('private-podman');
                const daemon = report.checks.find(check => check.code === 'DAEMON_AVAILABLE');
                expect(daemon.detail).toContain(`conf=${path.join(tempHome, '.manyoyo', 'runtime', 'podman', 'containers.conf')}`);
                expect(daemon.detail).toContain(`xdg=${path.join(tempHome, '.manyoyo', 'runtime', 'podman', 'data')}`);
            } finally {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
        });
    });

    // ==============================================================================
    // 选项测试
    // ==============================================================================

    describe('Options', () => {
        test('build --yes option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} build --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--yes');
        });

        test('build --update-agents option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} build --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--update-agents');
        });

        test('run should not expose --yes option', () => {
            const output = execSync(
                `node ${BIN_PATH} run --help`,
                { encoding: 'utf-8' }
            );
            expect(output).not.toContain('--yes');
        });

        test('--rm-on-exit option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} run --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--rm-on-exit');
        });

        test('--ss option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} run --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--ss');
        });

        test('serve subcommand should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('serve');
        });

        test('ps subcommand should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('ps');
        });

        test('images subcommand should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('images');
        });

        test('ls subcommand should be rejected', () => {
            expect(() => {
                execSync(`node ${BIN_PATH} ls`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
            }).toThrow();
        });

        test('ps should list manyoyo containers', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ps-'));
            const fakeDockerPath = path.join(tempDir, 'docker');
            const dockerLogPath = path.join(tempDir, 'docker.log');

            fs.writeFileSync(fakeDockerPath, `#!/bin/sh
echo "$@" >> "${dockerLogPath}"
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "images" ]; then
  echo "localhost/xcanwin/manyoyo:1.8.0-common"
  exit 0
fi
if [ "$1" = "ps" ]; then
  printf "NAMES\\tSTATUS\\tSIZE\\tID\\tIMAGE\\tPORTS\\tNETWORKS\\tMOUNTS\\n"
  printf "my-test\\tUp 1 minute\\t10MB\\tcont123\\tlocalhost/xcanwin/manyoyo:1.8.0-common\\t\\t\\t\\n"
  exit 0
fi
exit 0
            `, { mode: 0o755 });

            try {
                const output = execSync(`"${process.execPath}" ${BIN_PATH} ps`, {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        PATH: `${tempDir}:${process.env.PATH}`
                    }
                });
                const dockerArgs = fs.readFileSync(dockerLogPath, 'utf-8').trim().split('\n');
                expect(dockerArgs.some(line => line.startsWith('ps -a --size'))).toBe(true);
                expect(output).toContain('my-test');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('images should list manyoyo images', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-images-'));
            const fakeDockerPath = path.join(tempDir, 'docker');
            const dockerLogPath = path.join(tempDir, 'docker.log');

            fs.writeFileSync(fakeDockerPath, `#!/bin/sh
echo "$@" >> "${dockerLogPath}"
if [ "$1" = "--version" ]; then
  echo "Docker version 26.0.0"
  exit 0
fi
if [ "$1" = "images" ]; then
  printf "localhost/xcanwin/manyoyo\\t1.8.0-common\\timg123\\t2 hours ago\\t1.2GB\\n"
  exit 0
fi
exit 0
            `, { mode: 0o755 });

            try {
                const output = execSync(`"${process.execPath}" ${BIN_PATH} images`, {
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        PATH: `${tempDir}:${process.env.PATH}`
                    }
                });
                const dockerArgs = fs.readFileSync(dockerLogPath, 'utf-8').trim().split('\n');
                expect(dockerArgs.some(line => line.startsWith('images -a --format'))).toBe(true);
                expect(output).toContain('REPOSITORY');
                expect(output).toContain('localhost/xcanwin/manyoyo');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('--port option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} run --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('--port');
        });

        test('-u and -P options should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} serve --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('-u');
            expect(output).toContain('-P');
        });

        test('init option should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('init');
        });

        test('update subcommand should be accepted', () => {
            const output = execSync(
                `node ${BIN_PATH} --help`,
                { encoding: 'utf-8' }
            );
            expect(output).toContain('update');
        });

        test('update should invoke npm update when global install source is registry', () => {
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
                execSync(`"${process.execPath}" ${BIN_PATH} update`, {
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
                expect(npmArgs).toContain('update -g @xcanwin/manyoyo --prefer-online');
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('update should skip npm update when global install source is local file install', () => {
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
                execSync(`"${process.execPath}" ${BIN_PATH} update`, {
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
                expect(npmArgs.some(line => line.startsWith('update -g @xcanwin/manyoyo --prefer-online'))).toBe(false);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        test('config show should include server mode and port', () => {
            const output = execSync(
                `node ${BIN_PATH} config show --serve 127.0.0.1:39001`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.server).toBe(true);
            expect(config.serverPort).toBe(39001);
        });

        test('config show should reject serve port-only format', () => {
            expect(() => {
                execSync(
                    `node ${BIN_PATH} config show --serve 39001`,
                    { encoding: 'utf-8', stdio: 'pipe' }
                );
            }).toThrow();
        });

        test('config show should parse server host and port', () => {
            const output = execSync(
                `node ${BIN_PATH} config show --serve 0.0.0.0:39001`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.server).toBe(true);
            expect(config.serverHost).toBe('0.0.0.0');
            expect(config.serverPort).toBe(39001);
        });

        test('config show should default server user to admin', () => {
            const output = execSync(
                `node ${BIN_PATH} config show --serve`,
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

        test('config show should include server auth config', () => {
            const output = execSync(
                `node ${BIN_PATH} config show --serve -U webadmin -P topsecret`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.serverUser).toBe('webadmin');
            expect(config.serverPass).toContain('****');
            expect(config.serverPass).not.toBe('topsecret');
        });

        test('config show should reject legacy short user option -u', () => {
            expect(() => {
                execSync(
                    `node ${BIN_PATH} config show --serve -u webadmin -P topsecret`,
                    { encoding: 'utf-8', stdio: 'pipe' }
                );
            }).toThrow();
        });

        test('quiet options should work', () => {
            const output = execSync(
                `node ${BIN_PATH} config show -q tip -q cmd`,
                { encoding: 'utf-8' }
            );
            const config = JSON.parse(output);
            expect(config.quiet).toContain('tip');
            expect(config.quiet).toContain('cmd');
        });
    });
});
