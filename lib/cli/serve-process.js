'use strict';

function createServeProcessManager(dependencies) {
    const {
        fs,
        path,
        os,
        processRef,
        globalRef,
        spawn,
        sleep,
        buildLogPath,
        log,
        colors
    } = dependencies;

    function buildDetachedServeArgv(argv) {
        return argv.filter(arg => !['-d', '--detach', '--restart'].includes(String(arg || '')));
    }

    function buildDetachedServeEnv(runtime) {
        const env = { ...processRef.env };
        if (runtime.serverAuthUser) env.MANYOYO_SERVER_USER = runtime.serverAuthUser;
        if (runtime.serverAuthPass) env.MANYOYO_SERVER_PASS = runtime.serverAuthPass;
        return env;
    }

    function formatServeListenHost(host) {
        const text = String(host || '').trim() || '127.0.0.1';
        return text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
    }

    function buildServeListenLabel(host, port) {
        return `${formatServeListenHost(host)}:${port}`;
    }

    function buildServePidFile(host, port, homeDir = os.homedir()) {
        const dir = path.join(homeDir, '.manyoyo', 'run', 'serve');
        const listen = buildServeListenLabel(host, port);
        const safeName = listen.replace(/[^A-Za-z0-9_.-]+/g, '_');
        return { dir, listen, path: path.join(dir, `${safeName}.pid`) };
    }

    function removeServePidFile(filePath) {
        if (!filePath) return;
        try {
            fs.rmSync(filePath, { force: true });
        } catch (e) {
            // ignore cleanup failures
        }
    }

    function isProcessRunning(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            processRef.kill(pid, 0);
            return true;
        } catch (e) {
            return e && e.code !== 'ESRCH';
        }
    }

    function readServePidFile(filePath) {
        try {
            const text = fs.readFileSync(filePath, 'utf-8').trim();
            return /^\d+$/.test(text) ? Number(text) : 0;
        } catch (e) {
            return 0;
        }
    }

    function getServePidTarget(host, port, homeDir = os.homedir()) {
        const pidFile = buildServePidFile(host, port, homeDir);
        const pid = readServePidFile(pidFile.path);
        if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
            removeServePidFile(pidFile.path);
            return null;
        }
        return { pid, listen: pidFile.listen, path: pidFile.path };
    }

    function installServePidCleanup(pidFilePath, logger) {
        if (!pidFilePath || globalRef.__manyoyoServePidCleanupInstalled) return;
        globalRef.__manyoyoServePidCleanupInstalled = true;
        processRef.on('exit', () => {
            removeServePidFile(pidFilePath);
            if (logger && typeof logger.info === 'function') {
                logger.info('serve pid file removed', { pidFilePath });
            }
        });
    }

    function writeServePidFile(runtime, serverHandle) {
        const pidFile = buildServePidFile(serverHandle.host, serverHandle.port);
        fs.mkdirSync(pidFile.dir, { recursive: true });
        fs.writeFileSync(pidFile.path, `${processRef.pid}\n`);
        installServePidCleanup(pidFile.path, runtime && runtime.logger);
        return pidFile.path;
    }

    async function stopServeProcess(runtime, options = {}) {
        const commandName = options.commandName || '--stop';
        if (!runtime || !runtime.serverListenSpecified) {
            throw new Error(`serve ${commandName} 必须显式传入 listen，例如 manyoyo serve 127.0.0.1:3000 ${commandName}`);
        }
        const target = getServePidTarget(runtime.serverHost, runtime.serverPort);
        if (!target) {
            log(`${colors.YELLOW}⚠️  未发现运行中的 serve 实例: ${buildServeListenLabel(runtime.serverHost, runtime.serverPort)}${colors.NC}`);
            return false;
        }
        try {
            processRef.kill(target.pid, 'SIGTERM');
        } catch (e) {
            if (!e || e.code !== 'ESRCH') throw e;
        }
        await sleep(200);
        if (isProcessRunning(target.pid)) {
            try {
                processRef.kill(target.pid, 'SIGKILL');
            } catch (e) {
                if (!e || e.code !== 'ESRCH') throw e;
            }
        }
        removeServePidFile(target.path);
        log(`${colors.GREEN}✅ 已停止 serve: ${target.listen} (pid: ${target.pid})${colors.NC}`);
        return true;
    }

    function relaunchServeDetached(runtime) {
        const serveLog = buildLogPath('serve');
        fs.mkdirSync(serveLog.dir, { recursive: true });
        const existing = getServePidTarget(runtime.serverHost, runtime.serverPort);
        if (existing) {
            log(`${colors.YELLOW}⚠️  serve 已在后台运行: ${existing.listen} (pid: ${existing.pid})${colors.NC}`);
            return;
        }
        const child = spawn(processRef.argv[0], buildDetachedServeArgv(processRef.argv.slice(1)), {
            detached: true,
            stdio: 'ignore',
            env: buildDetachedServeEnv(runtime)
        });
        child.unref();
        log(`${colors.GREEN}✅ MANYOYO Web 服务已在后台启动: http://${buildServeListenLabel(runtime.serverHost, runtime.serverPort)}${colors.NC}`);
        log(`PID: ${child.pid}`);
        log(`日志: ${serveLog.path}`);
        log(`登录用户名: ${runtime.serverAuthUser}`);
        log(runtime.serverAuthPassAuto
            ? `登录密码(本次随机): ${runtime.serverAuthPass}`
            : '登录密码: 使用你配置的 serve -P / serverPass / MANYOYO_SERVER_PASS');
    }

    return {
        buildDetachedServeArgv,
        buildDetachedServeEnv,
        formatServeListenHost,
        buildServeListenLabel,
        buildServePidFile,
        removeServePidFile,
        isProcessRunning,
        readServePidFile,
        getServePidTarget,
        installServePidCleanup,
        writeServePidFile,
        stopServeProcess,
        relaunchServeDetached
    };
}

module.exports = { createServeProcessManager };
