'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function getFileSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function quoteShellArg(value) {
    const text = String(value);
    if (text.includes(' ') || text.includes('"') || text.includes('=')) {
        return `"${text.replace(/"/g, '\\"')}"`;
    }
    return text;
}

function ensureDirectoryIfMissing(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function loadBuildCacheTimestamps(timestampFile) {
    if (!fs.existsSync(timestampFile)) return {};
    try {
        return JSON.parse(fs.readFileSync(timestampFile, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveBuildCacheTimestamps(timestampFile, timestamps) {
    fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
}

function createBuildCacheContext(ctx) {
    const cacheDir = path.join(ctx.rootDir, 'docker', 'cache');
    ensureDirectoryIfMissing(cacheDir);

    const config = ctx.loadConfig();
    const timestampFile = path.join(cacheDir, '.timestamps.json');
    return {
        cacheDir,
        timestampFile,
        cacheTTLDays: config.cacheTTL ?? ctx.cacheTtlDays,
        nodeMirrors: [config.nodeMirror, 'https://mirrors.tencent.com/nodejs-release', 'https://nodejs.org/dist'].filter(Boolean),
        timestamps: loadBuildCacheTimestamps(timestampFile),
        now: new Date()
    };
}

function isBuildCacheExpired(cache, key) {
    if (!cache.timestamps[key]) return true;
    const cachedTime = new Date(cache.timestamps[key]);
    const diffDays = (cache.now - cachedTime) / (1000 * 60 * 60 * 24);
    return diffDays > cache.cacheTTLDays;
}

function touchBuildCache(cache, key) {
    cache.timestamps[key] = cache.now.toISOString();
    saveBuildCacheTimestamps(cache.timestampFile, cache.timestamps);
}

function resolveBuildCacheArch() {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    return { arch, archNode: arch === 'amd64' ? 'x64' : 'arm64' };
}

function prepareNodeBuildCache(ctx, cache, archNode) {
    const { RED, GREEN, YELLOW, BLUE, NC } = ctx.colors;
    const nodeCacheDir = path.join(cache.cacheDir, 'node');
    const nodeVersion = 24;
    const nodeKey = 'node/';

    ensureDirectoryIfMissing(nodeCacheDir);
    const hasNodeCache = fs.readdirSync(nodeCacheDir).some(fileName => (
        fileName.startsWith('node-') && fileName.includes(`linux-${archNode}`)
    ));
    if (hasNodeCache && !isBuildCacheExpired(cache, nodeKey)) {
        ctx.log(`${GREEN}✓ Node.js 缓存已存在${NC}`);
        return;
    }

    ctx.log(`${YELLOW}下载 Node.js ${nodeVersion} (${archNode})...${NC}`);

    for (const mirror of cache.nodeMirrors) {
        try {
            ctx.log(`${BLUE}尝试镜像源: ${mirror}${NC}`);
            const shasumUrl = `${mirror}/latest-v${nodeVersion}.x/SHASUMS256.txt`;
            const shasumContent = ctx.runCmd('curl', ['-fsSL', shasumUrl], { stdio: 'pipe' });
            const shasumLine = shasumContent.split('\n').find(line => line.includes(`linux-${archNode}.tar.gz`));
            if (!shasumLine) continue;

            const [expectedHash, fileName] = shasumLine.trim().split(/\s+/);
            const nodeTargetPath = path.join(nodeCacheDir, fileName);
            ctx.runCmd('curl', ['-fsSL', `${mirror}/latest-v${nodeVersion}.x/${fileName}`, '-o', nodeTargetPath], { stdio: 'inherit' });

            if (getFileSha256(nodeTargetPath) !== expectedHash) {
                ctx.log(`${RED}SHA256 校验失败，删除文件${NC}`);
                fs.unlinkSync(nodeTargetPath);
                continue;
            }

            ctx.log(`${GREEN}✓ SHA256 校验通过${NC}`);
            touchBuildCache(cache, nodeKey);
            ctx.log(`${GREEN}✓ Node.js 下载完成${NC}`);
            return;
        } catch (e) {
            ctx.log(`${YELLOW}镜像源 ${mirror} 失败，尝试下一个...${NC}`);
        }
    }

    ctx.error(`${RED}错误: Node.js 下载失败（所有镜像源均不可用）${NC}`);
    throw new Error('Node.js download failed');
}

function prepareJdtlsBuildCache(ctx, cache, imageTool) {
    const { RED, GREEN, YELLOW, NC } = ctx.colors;
    if (!(imageTool === 'full' || imageTool.includes('java'))) return;

    const jdtlsCacheDir = path.join(cache.cacheDir, 'jdtls');
    const jdtlsKey = 'jdtls/jdt-language-server-latest.tar.gz';
    const jdtlsPath = path.join(cache.cacheDir, jdtlsKey);

    ensureDirectoryIfMissing(jdtlsCacheDir);
    if (fs.existsSync(jdtlsPath) && !isBuildCacheExpired(cache, jdtlsKey)) {
        ctx.log(`${GREEN}✓ JDT LSP 缓存已存在${NC}`);
        return;
    }

    const tmpDir = path.join(jdtlsCacheDir, '.tmp-apk');
    const apkPath = path.join(tmpDir, 'jdtls.apk');
    ctx.log(`${YELLOW}下载 JDT Language Server...${NC}`);

    try {
        ensureDirectoryIfMissing(tmpDir);
        ctx.runCmd('curl', ['-fsSL', 'https://mirrors.tencent.com/alpine/latest-stable/community/x86_64/jdtls-1.53.0-r0.apk', '-o', apkPath], { stdio: 'inherit' });
        ctx.runCmd('tar', ['-xzf', apkPath, '-C', tmpDir], { stdio: 'inherit' });
        ctx.runCmd('tar', ['-czf', jdtlsPath, '-C', path.join(tmpDir, 'usr', 'share', 'jdtls'), '.'], { stdio: 'inherit' });
        touchBuildCache(cache, jdtlsKey);
        ctx.log(`${GREEN}✓ JDT LSP 下载完成${NC}`);
    } catch (e) {
        ctx.error(`${RED}错误: JDT LSP 下载失败${NC}`);
        throw e;
    } finally {
        try { ctx.runCmd('rm', ['-rf', tmpDir], { stdio: 'inherit', ignoreError: true }); } catch (e) {}
    }
}

function cleanupGoTmpPath(ctx, tmpGoPath, warnOnError) {
    const { YELLOW, NC } = ctx.colors;
    if (!fs.existsSync(tmpGoPath)) return;

    let cleanupFailed = false;
    try {
        ctx.runCmd('go', ['clean', '-modcache'], {
            stdio: 'inherit',
            ignoreError: true,
            env: { ...process.env, GOPATH: tmpGoPath }
        });
    } catch (e) { cleanupFailed = true; }
    try { ctx.runCmd('chmod', ['-R', 'u+w', tmpGoPath], { stdio: 'inherit', ignoreError: true }); } catch (e) { cleanupFailed = true; }
    try { ctx.runCmd('rm', ['-rf', tmpGoPath], { stdio: 'inherit', ignoreError: true }); } catch (e) { cleanupFailed = true; }
    if (cleanupFailed && warnOnError) {
        ctx.log(`${YELLOW}提示: 临时目录清理失败，可手动删除 ${tmpGoPath}${NC}`);
    }
}

function isGoCommandMissing(error) {
    const message = error && error.message ? String(error.message) : '';
    const stderr = error && error.stderr ? String(error.stderr) : '';
    const stdout = error && error.stdout ? String(error.stdout) : '';
    const combined = `${message}\n${stderr}\n${stdout}`.toLowerCase();
    if (error && String(error.code || '').toUpperCase() === 'ENOENT') {
        return /\bgo\b/.test(message.toLowerCase()) || /spawnsync go enoent|spawn go enoent/.test(combined);
    }
    return /spawnsync go enoent|spawn go enoent|go: not found|go: command not found|command not found: go/.test(combined);
}

function resolveGoplsSource(tmpGoPath, arch) {
    const primary = path.join(tmpGoPath, 'bin', `linux_${arch}`, 'gopls');
    if (fs.existsSync(primary)) return primary;
    const fallback = path.join(tmpGoPath, 'bin', 'gopls');
    return fs.existsSync(fallback) ? fallback : '';
}

function prepareGoplsBuildCache(ctx, cache, imageTool, arch) {
    const { RED, GREEN, YELLOW, NC } = ctx.colors;
    if (!(imageTool === 'full' || imageTool.includes('go'))) return;

    const goplsCacheDir = path.join(cache.cacheDir, 'gopls');
    const goplsKey = `gopls/gopls-linux-${arch}`;
    const goplsPath = path.join(cache.cacheDir, goplsKey);

    ensureDirectoryIfMissing(goplsCacheDir);
    if (fs.existsSync(goplsPath) && !isBuildCacheExpired(cache, goplsKey)) {
        ctx.log(`${GREEN}✓ gopls 缓存已存在${NC}`);
        return;
    }

    const tmpGoPath = path.join(cache.cacheDir, '.tmp-go');
    ctx.log(`${YELLOW}下载 gopls (${arch})...${NC}`);

    try {
        cleanupGoTmpPath(ctx, tmpGoPath, false);
        ensureDirectoryIfMissing(tmpGoPath);

        ctx.runCmd('go', ['install', 'golang.org/x/tools/gopls@latest'], {
            stdio: 'inherit',
            env: { ...process.env, GOPATH: tmpGoPath, GOOS: 'linux', GOARCH: arch }
        });

        const sourcePath = resolveGoplsSource(tmpGoPath, arch);
        if (!sourcePath) throw new Error(`gopls binary not found in ${tmpGoPath}`);
        fs.copyFileSync(sourcePath, goplsPath);
        ctx.runCmd('chmod', ['+x', goplsPath], { stdio: 'inherit' });

        touchBuildCache(cache, goplsKey);
        ctx.log(`${GREEN}✓ gopls 下载完成${NC}`);
        cleanupGoTmpPath(ctx, tmpGoPath, true);
    } catch (e) {
        if (isGoCommandMissing(e)) {
            ctx.log(`${YELLOW}提示: 未检测到本机 go，跳过 gopls 本地缓存预下载，将在镜像构建阶段安装${NC}`);
            cleanupGoTmpPath(ctx, tmpGoPath, false);
            return;
        }
        ctx.error(`${RED}错误: gopls 下载失败${NC}`);
        throw e;
    }
}

function createBuildCacheArtifacts(ctx, cache, imageTool, archInfo) {
    return [
        {
            name: 'node',
            prepare: () => prepareNodeBuildCache(ctx, cache, archInfo.archNode)
        },
        {
            name: 'jdtls',
            prepare: () => prepareJdtlsBuildCache(ctx, cache, imageTool)
        },
        {
            name: 'gopls',
            prepare: () => prepareGoplsBuildCache(ctx, cache, imageTool, archInfo.arch)
        }
    ];
}

async function prepareBuildCache(ctx, imageTool) {
    const { CYAN, GREEN, NC } = ctx.colors;
    const cache = createBuildCacheContext(ctx);
    const archInfo = resolveBuildCacheArch();
    const artifacts = createBuildCacheArtifacts(ctx, cache, imageTool, archInfo);

    ctx.log(`\n${CYAN}准备构建缓存...${NC}`);
    artifacts.forEach(artifact => artifact.prepare());
    saveBuildCacheTimestamps(cache.timestampFile, cache.timestamps);
    ctx.log(`${GREEN}✅ 构建缓存准备完成${NC}\n`);
}

function resolveToolFromBuildArgs(args) {
    for (const value of args) {
        if (typeof value === 'string' && value.startsWith('TOOL=')) return value.slice(5);
    }
    return '';
}

function extractBuildArgValues(args) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
        const current = args[i];
        if (current === '--build-arg') {
            const next = args[i + 1];
            if (typeof next === 'string' && next.length > 0) {
                values.push(next);
                i += 1;
            }
            continue;
        }
        if (typeof current === 'string' && current.startsWith('--build-arg=')) {
            values.push(current.slice('--build-arg='.length));
        }
    }
    return values;
}

function isBuildCapabilityError(error) {
    const combined = [
        error && error.message ? error.message : '',
        error && error.stderr ? String(error.stderr) : '',
        error && error.stdout ? String(error.stdout) : ''
    ].join('\n').toLowerCase();

    const patterns = [
        /unknown flag/,
        /unknown shorthand flag/,
        /unknown option/,
        /unrecognized option/,
        /unknown instruction:\s*"?((case|if|then|fi|for|while|do|done|esac))"?/,
        /buildx .* not available/,
        /buildx .* not found/,
        /buildx .* not enabled/,
        /'buildx' is not a docker command/,
        /the --load option requires buildx/,
        /unsupported.*--load/,
        /does not support.*--load/,
        /driver .* not supported/,
        /no such plugin.*buildx/
    ];
    return patterns.some(pattern => pattern.test(combined));
}

function buildBuildkitRunArgs(ctx, dockerfilePath, fullImageTag, imageBuildArgs) {
    const dockerfileRelativePath = path.relative(ctx.rootDir, dockerfilePath).split(path.sep).join('/');
    const buildArgs = extractBuildArgValues(imageBuildArgs);
    const args = [
        'run', '--rm', '--privileged',
        '--network', `host`,
        '--volume', `${ctx.rootDir}:/workspace`,
        '--entrypoint', 'buildctl-daemonless.sh',
        'docker.io/moby/buildkit:latest',
        'build',
        '--frontend', 'dockerfile.v0',
        '--local', 'context=/workspace',
        '--local', 'dockerfile=/workspace',
        '--opt', `filename=${dockerfileRelativePath}`,
        '--opt', 'network=host',
        '--opt', `build-arg:HTTP_PROXY=${process.env.HTTP_PROXY}`,
        '--opt', `build-arg:HTTPS_PROXY=${process.env.HTTPS_PROXY}`,
        '--opt', `build-arg:ALL_PROXY=${process.env.ALL_PROXY}`,
        '--opt', `build-arg:NO_PROXY=${process.env.NO_PROXY}`
    ];

    for (const value of buildArgs) {
        args.push('--opt', `build-arg:${value}`);
    }

    args.push('--output', `type=docker,name=${fullImageTag},dest=-`);
    return args;
}

function runCmdPipeline(leftCmd, leftArgs, rightCmd, rightArgs, options = {}) {
    const stdio = options.stdio || 'inherit';

    return new Promise((resolve, reject) => {
        let settled = false;
        const left = spawn(leftCmd, leftArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        const right = spawn(rightCmd, rightArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        right.stdin.on('error', () => {});
        left.stdout.pipe(right.stdin);

        if (stdio === 'inherit') {
            left.stderr.pipe(process.stderr);
            right.stdout.pipe(process.stdout);
            right.stderr.pipe(process.stderr);
        }

        let leftExited = false;
        let rightExited = false;
        let leftCode = 1;
        let rightCode = 1;

        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) {
                try { left.kill(); } catch (e) {}
                try { right.kill(); } catch (e) {}
                reject(error);
                return;
            }
            if (leftCode === 0 && rightCode === 0) {
                resolve();
                return;
            }
            reject(new Error(`Command pipeline failed: ${leftCmd}(${leftCode}) | ${rightCmd}(${rightCode})`));
        };

        const onClose = () => {
            if (leftExited && rightExited) finish();
        };

        left.on('error', finish);
        right.on('error', finish);
        left.on('close', (code) => {
            leftExited = true;
            leftCode = typeof code === 'number' ? code : 1;
            onClose();
        });
        right.on('close', (code) => {
            rightExited = true;
            rightCode = typeof code === 'number' ? code : 1;
            onClose();
        });
    });
}

const AGENT_UPDATE_PACKAGES = [
    'npm@latest',
    '@anthropic-ai/claude-code@latest',
    '@openai/codex@latest',
    '@google/gemini-cli@latest',
    'opencode-ai@latest'
];
const AGENT_VERSION_CHECK_COMMAND = [
    'printf "claude: " && claude --version',
    'printf "codex: " && codex --version',
    'printf "gemini: " && gemini --version',
    'printf "opencode: " && opencode --version',
    'printf "npm: " && npm --version'
].join(' && ');

function createAgentUpdateContainerName() {
    return `manyoyo-update-agents-${crypto.randomBytes(6).toString('hex')}`;
}

const MANYOYO_DEFAULT_CMD = ['supervisord', '-n', '-c', '/etc/supervisor/supervisord.conf'];

function parseImageConfig(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'string') return {};
    try {
        const parsed = JSON.parse(rawConfig);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function isAgentUpdateCommand(cmd) {
    const text = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
    return AGENT_UPDATE_PACKAGES.some(pkg => text.includes(pkg));
}

function buildImageImportChangeArgs(config) {
    const changes = [];
    const envList = Array.isArray(config.Env) ? config.Env : [];
    envList.forEach(env => {
        if (typeof env === 'string' && env.trim()) {
            changes.push('--change', `ENV ${env}`);
        }
    });

    if (config.Entrypoint) {
        changes.push('--change', `ENTRYPOINT ${JSON.stringify(config.Entrypoint)}`);
    }

    const cmd = isAgentUpdateCommand(config.Cmd) ? MANYOYO_DEFAULT_CMD : (config.Cmd || MANYOYO_DEFAULT_CMD);
    changes.push('--change', `CMD ${JSON.stringify(cmd)}`);

    const workingDir = typeof config.WorkingDir === 'string' && config.WorkingDir.trim()
        ? config.WorkingDir
        : '/tmp';
    changes.push('--change', `WORKDIR ${workingDir}`);

    if (typeof config.User === 'string' && config.User.trim()) {
        changes.push('--change', `USER ${config.User}`);
    }

    const exposedPorts = config.ExposedPorts && typeof config.ExposedPorts === 'object'
        ? Object.keys(config.ExposedPorts)
        : [];
    exposedPorts.forEach(port => {
        if (port) changes.push('--change', `EXPOSE ${port}`);
    });

    const labels = config.Labels && typeof config.Labels === 'object' ? config.Labels : {};
    Object.entries(labels).forEach(([key, value]) => {
        changes.push('--change', `LABEL ${key}=${value}`);
    });

    return changes;
}

async function updateAgentsInExistingImage(ctx, fullImageTag) {
    const { RED, GREEN, YELLOW, BLUE, CYAN, NC } = ctx.colors;
    const containerName = ctx.agentUpdateContainerName || createAgentUpdateContainerName();
    const updateScript = [
        'echo "[manyoyo] Agent CLI versions before update:"',
        AGENT_VERSION_CHECK_COMMAND,
        `npm_config_update_notifier=false npm install -g ${AGENT_UPDATE_PACKAGES.map(quoteShellArg).join(' ')}`,
        'echo "[manyoyo] Agent CLI versions after update:"',
        AGENT_VERSION_CHECK_COMMAND,
        'npm_config_update_notifier=false npm cache clean --force --loglevel=error',
        'rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/.cache/node-gyp ~/.claude/plugins/cache ~/go/pkg/mod/cache',
        'rm -f /var/log/dpkg.log /var/log/bootstrap.log /var/lib/dpkg/status-old /var/cache/debconf/templates.dat-old'
    ].join(' && ');
    const runArgs = [
        'run',
        '--name', containerName,
        '--network', 'host',
        fullImageTag,
        '/bin/bash',
        '-lc',
        updateScript
    ];
    const cleanupArgs = ['rm', '-f', containerName];
    let imageConfig = {};

    ctx.log(`${CYAN}🔄 正在更新已有镜像内 Agent CLI: ${YELLOW}${fullImageTag}${NC}`);
    ctx.log(`${BLUE}更新范围: Claude/Codex/Gemini/OpenCode CLI -> latest${NC}\n`);

    try {
        imageConfig = parseImageConfig(ctx.runCmd(ctx.dockerCmd, [
            'image',
            'inspect',
            fullImageTag,
            '--format',
            '{{json .Config}}'
        ], { stdio: 'pipe' }));
    } catch (e) {
        ctx.error(`${RED}错误: 找不到本地镜像 ${fullImageTag}${NC}`);
        ctx.error(`${YELLOW}请先执行 ${ctx.manyoyoName} build --iv ${fullImageTag.split(':').pop()} --yes 构建镜像。${NC}`);
        ctx.exit(1);
        return;
    }

    const importArgs = [
        'import',
        ...buildImageImportChangeArgs(imageConfig),
        '-',
        fullImageTag
    ];

    ctx.log(`${BLUE}准备执行命令:${NC}`);
    ctx.log(`${ctx.dockerCmd} ${runArgs.map(quoteShellArg).join(' ')}`);
    ctx.log(`${ctx.dockerCmd} export ${quoteShellArg(containerName)} | ${ctx.dockerCmd} ${importArgs.map(quoteShellArg).join(' ')}`);
    ctx.log(`${ctx.dockerCmd} ${cleanupArgs.map(quoteShellArg).join(' ')}\n`);

    if (!ctx.yesMode) {
        await ctx.askQuestion('❔ 是否继续更新并覆盖当前镜像 tag? [ 直接回车=继续, ctrl+c=取消 ]: ');
        ctx.log('');
    }

    const updateStartTime = Date.now();
    try {
        ctx.runCmd(ctx.dockerCmd, runArgs, { stdio: 'inherit' });
        await ctx.runCmdPipeline(ctx.dockerCmd, ['export', containerName], ctx.dockerCmd, importArgs, { stdio: 'inherit' });
        const updateDuration = ((Date.now() - updateStartTime) / 1000).toFixed(1);
        ctx.log(`\n${GREEN}✅ Agent CLI 更新成功: ${fullImageTag}${NC}`);
        ctx.log(`${GREEN}⏱️  更新耗时: ${updateDuration} 秒${NC}`);
    } catch (e) {
        ctx.error(`${RED}错误: Agent CLI 更新失败${NC}`);
        ctx.exit(1);
    } finally {
        try {
            ctx.runCmd(ctx.dockerCmd, cleanupArgs, { stdio: 'inherit', ignoreError: true });
        } catch (e) {}
    }
}

async function buildImage(options = {}) {
    const ctx = {
        imageBuildArgs: Array.isArray(options.imageBuildArgs) ? [...options.imageBuildArgs] : [],
        imageName: options.imageName,
        imageVersionTag: options.imageVersionTag,
        imageVersionDefault: options.imageVersionDefault || '',
        imageVersionBase: options.imageVersionBase || '1.0.0',
        parseImageVersionTag: options.parseImageVersionTag,
        manyoyoName: options.manyoyoName || 'manyoyo',
        yesMode: Boolean(options.yesMode),
        updateAgents: Boolean(options.updateAgents),
        agentUpdateContainerName: options.agentUpdateContainerName || '',
        dockerCmd: options.dockerCmd || 'docker',
        rootDir: options.rootDir || process.cwd(),
        loadConfig: options.loadConfig || (() => ({})),
        runCmd: options.runCmd,
        runCmdPipeline: options.runCmdPipeline || runCmdPipeline,
        askQuestion: options.askQuestion || (async () => ''),
        pruneDanglingImages: options.pruneDanglingImages || (() => {}),
        cacheTtlDays: options.cacheTtlDays || 2,
        log: options.log || console.log,
        error: options.error || console.error,
        exit: options.exit || (code => process.exit(code)),
        colors: options.colors || { RED: '', GREEN: '', YELLOW: '', BLUE: '', CYAN: '', NC: '' }
    };
    const { RED, GREEN, YELLOW, BLUE, CYAN, NC } = ctx.colors;

    const versionTag = ctx.imageVersionTag || ctx.imageVersionDefault || `${ctx.imageVersionBase}-common`;
    const parsedVersion = ctx.parseImageVersionTag(versionTag);
    if (!parsedVersion) {
        ctx.error(`${RED}错误: 镜像版本格式错误，必须为 <x.y.z-后缀>，例如 1.7.4-common: ${versionTag}${NC}`);
        ctx.exit(1);
        return;
    }

    const version = parsedVersion.baseVersion;
    let imageTool = parsedVersion.tool;
    const imageBuildArgs = [...ctx.imageBuildArgs];
    const toolFromArgs = resolveToolFromBuildArgs(imageBuildArgs);
    if (!toolFromArgs) {
        imageBuildArgs.push('--build-arg', `TOOL=${imageTool}`);
    } else {
        imageTool = toolFromArgs;
    }

    const fullImageTag = `${ctx.imageName}:${version}-${imageTool}`;
    if (ctx.updateAgents) {
        await updateAgentsInExistingImage(ctx, fullImageTag);
        return;
    }

    ctx.log(`${CYAN}🔨 正在构建镜像: ${YELLOW}${fullImageTag}${NC}`);
    ctx.log(`${BLUE}构建组件类型: ${imageTool}${NC}\n`);

    await prepareBuildCache(ctx, imageTool);

    // 记录构建开始时间
    const buildStartTime = Date.now();

    const dockerfilePath = path.join(ctx.rootDir, 'docker', 'manyoyo.Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
        ctx.error(`${RED}错误: 找不到 Dockerfile: ${dockerfilePath}${NC}`);
        ctx.exit(1);
        return;
    }

    const buildArgs = [
        'build', '-t', fullImageTag,
        '-f', dockerfilePath,
        ctx.rootDir,
        ...imageBuildArgs,
        '--load',
        '--progress=plain',
        '--no-cache'
    ];
    const buildkitRunArgs = buildBuildkitRunArgs(ctx, dockerfilePath, fullImageTag, imageBuildArgs);

    function logBuildSuccess() {
        const buildDuration = ((Date.now() - buildStartTime) / 1000).toFixed(1);
        ctx.log(`\n${GREEN}✅ 镜像构建成功: ${fullImageTag}${NC}`);
        ctx.log(`${GREEN}⏱️  构建耗时: ${buildDuration} 秒${NC}`);
        ctx.log(`${BLUE}使用镜像:${NC}`);
        ctx.log(`  ${ctx.manyoyoName} -n test --in ${ctx.imageName} --iv ${version}-${imageTool} -y c`);
        ctx.pruneDanglingImages();
    }

    ctx.log(`${BLUE}准备执行命令:${NC}`);
    ctx.log(`${ctx.dockerCmd} ${buildArgs.map(quoteShellArg).join(' ')}\n`);

    if (!ctx.yesMode) {
        await ctx.askQuestion('❔ 是否继续构建? [ 直接回车=继续, ctrl+c=取消 ]: ');
        ctx.log('');
    }

    try {
        ctx.runCmd(ctx.dockerCmd, buildArgs, { stdio: 'inherit' });
        logBuildSuccess();
        return;
    } catch (e) {
        const stderrText = e && e.stderr ? String(e.stderr).trim() : '';
        const stdoutText = e && e.stdout ? String(e.stdout).trim() : '';
        const hasDiagnostics = Boolean(stderrText || stdoutText);
        const capabilityError = isBuildCapabilityError(e);

        if (!capabilityError && hasDiagnostics) {
            ctx.error(`${RED}错误: 镜像构建失败${NC}`);
            ctx.exit(1);
            return;
        }
        if (!capabilityError && !hasDiagnostics) {
            ctx.log(`${YELLOW}⚠️  未捕获到构建器错误详情，尝试回退到 BuildKit...${NC}`);
        }
        ctx.log(`${YELLOW}⚠️  直接 build 失败，回退到 BuildKit...${NC}`);
        if (e && e.message) {
            ctx.log(`${YELLOW}原因: ${e.message}${NC}`);
        }
        ctx.log('');
        ctx.log(`${BLUE}回退命令:${NC}`);
        ctx.log(`${ctx.dockerCmd} ${buildkitRunArgs.map(quoteShellArg).join(' ')} | ${ctx.dockerCmd} load\n`);
    }

    try {
        await ctx.runCmdPipeline(ctx.dockerCmd, buildkitRunArgs, ctx.dockerCmd, ['load'], { stdio: 'inherit' });
        logBuildSuccess();
    } catch (e) {
        ctx.error(`${RED}错误: 镜像构建失败${NC}`);
        ctx.exit(1);
    }
}

module.exports = {
    buildImage
};
