const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildImage } = require('../lib/image-build');

function parseImageVersionTag(tag) {
    const match = String(tag || '').match(/^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
    if (!match) return null;
    return { baseVersion: match[1], tool: match[2] };
}

function createCommandError(message, stderr = '', stdout = '') {
    const err = new Error(message);
    err.stderr = stderr;
    err.stdout = stdout;
    return err;
}

function createTestRoot() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-image-build-'));
    const dockerDir = path.join(rootDir, 'docker');
    const dockerResDir = path.join(dockerDir, 'res');
    const cacheDir = path.join(dockerDir, 'cache');
    const nodeCacheDir = path.join(cacheDir, 'node');
    fs.mkdirSync(nodeCacheDir, { recursive: true });
    fs.mkdirSync(dockerResDir, { recursive: true });

    fs.writeFileSync(path.join(dockerDir, 'manyoyo.Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(dockerResDir, 'update-agents.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(nodeCacheDir, 'node-v24.0.0-linux-x64.tar.gz'), 'cache');
    fs.writeFileSync(path.join(cacheDir, '.timestamps.json'), JSON.stringify({
        'node/': new Date().toISOString()
    }));

    return rootDir;
}

const tempRoots = [];

function createBaseOptions(overrides = {}) {
    const rootDir = createTestRoot();
    tempRoots.push(rootDir);
    const runCmd = jest.fn(() => '');
    const runCmdPipeline = jest.fn(async () => {});
    const log = jest.fn();
    const error = jest.fn();
    const pruneDanglingImages = jest.fn();
    const askQuestion = jest.fn(async () => '');

    return {
        rootDir,
        runCmd,
        runCmdPipeline,
        log,
        error,
        pruneDanglingImages,
        askQuestion,
        imageName: 'localhost/xcanwin/manyoyo',
        imageVersionTag: '1.8.0-common',
        parseImageVersionTag,
        yesMode: true,
        loadConfig: () => ({}),
        exit: (code) => { throw new Error(`exit:${code}`); },
        ...overrides
    };
}

describe('image-build with unified build and buildkit fallback', () => {
    afterEach(() => {
        while (tempRoots.length > 0) {
            const rootDir = tempRoots.pop();
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('podman should prefer native build when it succeeds', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman'
        });

        await buildImage(options);

        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'podman' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('podman should fallback to buildkit when native build hits capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            imageBuildArgs: ['--build-arg', 'APT_MIRROR=https://mirror.example'],
            runCmd: jest.fn(() => {
                throw createCommandError('unknown flag: --load');
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, leftArgs, rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('podman');
        expect(rightCmd).toBe('podman');
        expect(rightArgs).toEqual(['load']);
        expect(leftArgs).toEqual(expect.arrayContaining([
            'run',
            '--entrypoint',
            'buildctl-daemonless.sh',
            'docker.io/moby/buildkit:latest',
            '--frontend',
            'dockerfile.v0',
            '--opt',
            'build-arg:TOOL=common',
            '--opt',
            'build-arg:APT_MIRROR=https://mirror.example'
        ]));
        // 验证包含代理相关参数（值为 process.env 的值，可能是 undefined）
        expect(leftArgs).toContain('--opt');
        expect(leftArgs.some(arg => arg.startsWith('build-arg:HTTP_PROXY='))).toBe(true);
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('podman should not fallback when native build fails with non-capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'failed to solve: Dockerfile parse error',
                    'Build error: Dockerfile parse error line 12'
                );
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        expect(options.error).toHaveBeenCalled();
    });

    test('podman should fallback to buildkit on unknown CASE instruction from legacy builder', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'Error: building at STEP "CASE "',
                    'Build error: Unknown instruction: "CASE"'
                );
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, , rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('podman');
        expect(rightCmd).toBe('podman');
        expect(rightArgs).toEqual(['load']);
    });

    test('docker should prefer native build when it succeeds', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker'
        });

        await buildImage(options);

        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'docker' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('should update agents in existing image without rebuilding when updateAgents is enabled', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            updateAgents: true,
            agentUpdateContainerName: 'manyoyo-update-test',
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args[0] === 'image') {
                    return JSON.stringify({
                        Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8'],
                        Cmd: ['supervisord', '-n', '-c', '/etc/supervisor/supervisord.conf'],
                        WorkingDir: '/tmp',
                        Labels: { 'org.opencontainers.image.version': '24.04' }
                    });
                }
                return '';
            })
        });

        await buildImage(options);

        expect(options.runCmd.mock.calls.some(([cmd, args]) => (
            cmd === 'docker' && Array.isArray(args) && args[0] === 'build'
        ))).toBe(false);
        expect(options.runCmd).toHaveBeenNthCalledWith(1, 'docker', [
            'image',
            'inspect',
            'localhost/xcanwin/manyoyo:1.8.0-common',
            '--format',
            '{{json .Config}}'
        ], { stdio: 'pipe' });
        expect(options.runCmd).toHaveBeenNthCalledWith(2, 'docker', expect.arrayContaining([
            'run',
            '--name',
            'manyoyo-update-test',
            '--network',
            'host',
            '--volume',
            path.join(options.rootDir, 'docker', 'res', 'update-agents.sh') + ':/usr/local/bin/manyoyo-update-agents.sh:ro',
            '--env',
            'MANYOYO_AGENT_UPDATE_TARGETS=claude=@anthropic-ai/claude-code@latest codex=@openai/codex@latest',
            'localhost/xcanwin/manyoyo:1.8.0-common',
            '/bin/bash',
            '/usr/local/bin/manyoyo-update-agents.sh'
        ]), { stdio: 'inherit' });
        const runArgs = options.runCmd.mock.calls[1][1];
        const targetEnv = runArgs[runArgs.indexOf('--env') + 1];
        expect(targetEnv).toContain('claude=@anthropic-ai/claude-code@latest');
        expect(targetEnv).toContain('codex=@openai/codex@latest');
        expect(targetEnv).not.toContain('gemini=');
        expect(targetEnv).not.toContain('opencode=');
        expect(options.runCmdPipeline).toHaveBeenCalledWith(
            'docker',
            ['export', 'manyoyo-update-test'],
            'docker',
            expect.arrayContaining([
                'import',
                '--change',
                'ENV PATH=/usr/local/bin:/usr/bin:/bin',
                '--change',
                'CMD ["supervisord","-n","-c","/etc/supervisor/supervisord.conf"]',
                '--change',
                'WORKDIR /tmp',
                '-',
                'localhost/xcanwin/manyoyo:1.8.0-common'
            ]),
            { stdio: 'inherit' }
        );
        const importArgs = options.runCmdPipeline.mock.calls[0][3];
        expect(importArgs).toContain('LABEL org.opencontainers.image.version=24.04');
        expect(options.runCmd).toHaveBeenNthCalledWith(3, 'docker', [
            'rm',
            '-f',
            'manyoyo-update-test'
        ], { stdio: 'inherit', ignoreError: true });
    });

    test('should pass full agent targets to mounted update script for full image', async () => {
        const options = createBaseOptions({
            updateAgents: true,
            imageVersionTag: '1.8.0-full',
            agentUpdateContainerName: 'manyoyo-update-test',
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args[0] === 'image') {
                    return JSON.stringify({ Cmd: ['supervisord'], WorkingDir: '/tmp' });
                }
                return '';
            })
        });

        await buildImage(options);

        const runArgs = options.runCmd.mock.calls[1][1];
        const targetEnv = runArgs[runArgs.indexOf('--env') + 1];
        expect(targetEnv).toContain('claude=@anthropic-ai/claude-code@latest');
        expect(targetEnv).toContain('codex=@openai/codex@latest');
        expect(targetEnv).toContain('gemini=@google/gemini-cli@latest');
        expect(targetEnv).toContain('opencode=opencode-ai@latest');
    });

    test('update-agents resource script should skip missing commands and clean caches', () => {
        const rootDir = path.resolve(__dirname, '..');
        const scriptPath = path.join(rootDir, 'docker', 'res', 'update-agents.sh');
        const script = fs.readFileSync(scriptPath, 'utf8');

        expect(script).toContain('MANYOYO_AGENT_UPDATE_TARGETS');
        expect(script).toContain('command -v "$agent"');
        expect(script).toContain('skipped (command not found)');
        expect(script).toContain('npm install -g npm@latest "${update_packages[@]}"');
        expect(script).toContain('npm cache clean --force --loglevel=error');
    });

    test('should restore default cmd when flattening an image previously committed with update command', async () => {
        const options = createBaseOptions({
            updateAgents: true,
            agentUpdateContainerName: 'manyoyo-update-test',
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args[0] === 'image') {
                    return JSON.stringify({
                        Cmd: ['/bin/bash', '-lc', 'npm install -g @openai/codex@latest'],
                        WorkingDir: '/tmp'
                    });
                }
                return '';
            })
        });

        await buildImage(options);

        const importArgs = options.runCmdPipeline.mock.calls[0][3];
        expect(importArgs).toEqual(expect.arrayContaining([
            '--change',
            'CMD ["supervisord","-n","-c","/etc/supervisor/supervisord.conf"]'
        ]));
    });

    test('should fail updateAgents when target image does not exist', async () => {
        const options = createBaseOptions({
            updateAgents: true,
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args[0] === 'image') {
                    throw createCommandError('No such image');
                }
                return '';
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.error).toHaveBeenCalledWith(expect.stringContaining('找不到本地镜像'));
    });

    test('docker should fallback to buildkit when native build hits capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError('unknown option --load');
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, leftArgs, rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('docker');
        expect(rightCmd).toBe('docker');
        expect(rightArgs).toEqual(['load']);
        expect(leftArgs).toEqual(expect.arrayContaining([
            'run',
            '--entrypoint',
            'buildctl-daemonless.sh',
            'docker.io/moby/buildkit:latest',
            '--frontend',
            'dockerfile.v0',
            '--opt',
            'build-arg:TOOL=common'
        ]));
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('docker should not fallback when native build fails with non-capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'failed to solve: syntax error',
                    'Dockerfile:23 syntax error'
                );
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        expect(options.error).toHaveBeenCalled();
    });

    test('should fallback when direct build fails without stderr/stdout diagnostics', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError('Command failed: podman build ...');
            })
        });

        await buildImage(options);
        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
    });

    test('should fail when buildkit fallback also fails', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError('unknown flag: --load');
            }),
            runCmdPipeline: jest.fn(async () => {
                throw new Error('buildkit unavailable');
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        expect(options.error).toHaveBeenCalled();
    });

    test('should honor cacheTTL=0 from config without falling back to default', async () => {
        const cacheHash = crypto.createHash('sha256').update('cache').digest('hex');
        const options = createBaseOptions({
            loadConfig: () => ({ cacheTTL: 0 }),
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'curl') {
                    if (Array.isArray(args) && args.some(arg => String(arg).includes('SHASUMS256.txt'))) {
                        return `${cacheHash} node-v24.0.0-linux-x64.tar.gz\n`;
                    }
                    return '';
                }
                return '';
            })
        });

        fs.writeFileSync(
            path.join(options.rootDir, 'docker', 'cache', '.timestamps.json'),
            JSON.stringify({ 'node/': '2000-01-01T00:00:00.000Z' })
        );

        await buildImage(options);
        const curlCalls = options.runCmd.mock.calls.filter(([cmd]) => cmd === 'curl');
        expect(curlCalls.length).toBeGreaterThan(0);
    });

    test('should skip local gopls cache when go command is unavailable', async () => {
        const options = createBaseOptions({
            imageVersionTag: '1.8.0-go',
            runCmd: jest.fn((cmd) => {
                if (cmd === 'go') {
                    const err = new Error('spawnSync go ENOENT');
                    err.code = 'ENOENT';
                    throw err;
                }
                return '';
            })
        });

        await buildImage(options);

        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'docker' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
        expect(options.log).toHaveBeenCalledWith(expect.stringContaining('跳过 gopls 本地缓存预下载'));
    });

    test('docker image should include built-in playwright cli headless config assets', () => {
        const rootDir = path.resolve(__dirname, '..');
        const dockerfile = fs.readFileSync(path.join(rootDir, 'docker', 'manyoyo.Dockerfile'), 'utf8');
        const configPath = path.join(rootDir, 'docker', 'res', 'playwright', 'cli-cont-headless.json');
        const initScriptPath = path.join(rootDir, 'docker', 'res', 'playwright', 'cli-cont-headless.init.js');
        const wrapperPath = path.join(rootDir, 'docker', 'res', 'playwright', 'playwright-cli-wrapper.sh');

        expect(dockerfile).toContain('COPY ./docker/res/playwright/cli-cont-headless.init.js /app/config/cli-cont-headless.init.js');
        expect(dockerfile).toContain('COPY ./docker/res/playwright/cli-cont-headless.json /app/config/cli-cont-headless.json');
        expect(dockerfile).toContain('COPY ./docker/res/playwright/playwright-cli-wrapper.sh /usr/local/bin/playwright-cli');
        expect(fs.existsSync(configPath)).toBe(true);
        expect(fs.existsSync(initScriptPath)).toBe(true);
        expect(fs.existsSync(wrapperPath)).toBe(true);
        expect(dockerfile).toContain('COPY ./package.json /tmp/manyoyo-package.json');
        expect(dockerfile).toContain('playwrightCliVersion');
        expect(dockerfile).toContain('npm install -g "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}"');
        expect(dockerfile).toContain('echo \'{"browser":{"browserName":"chromium","launchOptions":{"channel":"chromium"}}}\' > "${PLAYWRIGHT_CLI_INSTALL_DIR}/.playwright/cli.config.json"');
        expect(dockerfile).toContain('playwright-cli --config="${PLAYWRIGHT_CLI_INSTALL_DIR}/.playwright/cli.config.json" install --skills');
        expect(dockerfile).not.toContain('playwright install --with-deps chromium');

        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(cfg.outputDir).toBe('/tmp/.playwright-cli');
        expect(cfg.browser.initScript).toEqual(['/app/config/cli-cont-headless.init.js']);
        expect(cfg.browser.contextOptions.timezoneId).toBe('Asia/Shanghai');
        expect(cfg.browser.launchOptions.channel).toBe('chromium');

        const initScript = fs.readFileSync(initScriptPath, 'utf8');
        expect(initScript).toContain("Object.defineProperty(navProto, 'platform'");
        expect(initScript).toContain('MacIntel');

        const wrapper = fs.readFileSync(wrapperPath, 'utf8');
        expect(wrapper).toContain('install-browser');
        expect(wrapper).toContain('/cli.js');
    });

    test('docker image should clean known build caches and avoid tmp relay layers for language servers', () => {
        const rootDir = path.resolve(__dirname, '..');
        const dockerfile = fs.readFileSync(path.join(rootDir, 'docker', 'manyoyo.Dockerfile'), 'utf8');

        expect(dockerfile).toContain('~/.cache/node-gyp');
        expect(dockerfile).toContain('~/.claude/plugins/cache');
        expect(dockerfile).toContain('COPY --from=cache-stage /opt/jdtls /root/.local/share/jdtls');
        expect(dockerfile).not.toContain('COPY --from=cache-stage /opt/jdtls /tmp/jdtls-cache');
        expect(dockerfile).toContain('COPY --from=cache-stage /opt/gopls /usr/local/share/manyoyo-gopls');
        expect(dockerfile).not.toContain('COPY --from=cache-stage /opt/gopls /tmp/gopls-cache');
    });

});
