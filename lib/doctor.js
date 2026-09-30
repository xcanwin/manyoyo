'use strict';

const { resolveContainerMode } = require('./container-modes');
const { resolveAgentProgram } = require('./agent-resume');

function createCheck(code, status, summary, action = '', detail = '') {
    return { code, status, summary, action, detail };
}

function runDoctorChecks(options = {}) {
    const checks = [];
    const runCommand = typeof options.runCommand === 'function' ? options.runCommand : () => {
        throw new Error('未配置命令执行器');
    };
    const selectRuntime = typeof options.selectRuntime === 'function' ? options.selectRuntime : () => {
        throw new Error('未配置运行时选择器');
    };
    let runtimeCommand = '';
    let runtimeSource = null;
    let runtimeEnv = {};

    try {
        const selection = selectRuntime();
        runtimeCommand = selection.command;
        runtimeSource = selection.source;
        runtimeEnv = selection.env || {};
    } catch (error) {
        checks.push(createCheck('RUNTIME_UNAVAILABLE', 'error', '未找到 Docker 或 Podman', '安装并启动 Docker Desktop 或 Podman。', error.message || ''));
    }
    if (runtimeCommand) {
        let versionDetail = '';
        try {
            versionDetail = String(runCommand(runtimeCommand, ['--version'], { env: runtimeEnv }) || '').trim();
        } catch (error) {
            // 版本信息只是补充，daemon 检查会给出真正的结论。
        }
        checks.push(createCheck('RUNTIME_AVAILABLE', 'ok', `容器运行时: ${runtimeCommand}（来源: ${runtimeSource}）`, '', versionDetail));
        try {
            const detail = String(runCommand(runtimeCommand, ['info'], { env: runtimeEnv }) || '').trim();
            checks.push(createCheck('DAEMON_AVAILABLE', 'ok', `${runtimeCommand} daemon 可用`, '', detail));
        } catch (error) {
            checks.push(createCheck('DAEMON_UNAVAILABLE', 'error', `${runtimeCommand} daemon 不可用`, `启动 ${runtimeCommand} daemon 后重试。`, error.message || ''));
        }
        try {
            const image = `${options.imageName || ''}:${options.imageVersion || ''}`;
            const detail = String(runCommand(runtimeCommand, ['image', 'inspect', image], { env: runtimeEnv }) || '').trim();
            checks.push(createCheck('IMAGE_AVAILABLE', 'ok', `镜像可用: ${image}`, '', detail));
        } catch (error) {
            checks.push(createCheck('IMAGE_MISSING', 'warning', '目标镜像尚不可用', '执行 manyoyo build，或拉取匹配镜像。', error.message || ''));
        }
    }

    checks.push(options.configExists === true
        ? createCheck('CONFIG_AVAILABLE', 'ok', '配置文件可用')
        : createCheck('CONFIG_MISSING', 'warning', '未找到配置文件', '执行 manyoyo init 或通过 run 参数指定配置。'));

    const agentProgram = resolveAgentProgram(options.agentCommand || '');
    checks.push(agentProgram
        ? createCheck('AGENT_CONFIGURED', 'ok', `已配置 Agent: ${agentProgram}`)
        : createCheck('AGENT_NOT_CONFIGURED', 'warning', '未配置 Agent 命令', '设置 shell、yolo 或 agentPromptCommand。'));

    try {
        const mode = resolveContainerMode(options.containerMode || 'common');
        checks.push(createCheck('MODE_VALID', 'ok', `容器模式有效: ${mode.mode}`));
    } catch (error) {
        checks.push(createCheck('MODE_INVALID', 'error', '容器模式无效', '使用 common、dind 或 sock。', error.message || ''));
    }

    const pluginConfig = options.pluginConfig;
    checks.push(pluginConfig && typeof pluginConfig === 'object' && !Array.isArray(pluginConfig)
        ? createCheck('PLUGIN_CONFIG_VALID', 'ok', '插件配置有效')
        : createCheck('PLUGIN_CONFIG_INVALID', 'warning', '插件配置不存在或格式无效', '将 plugins 配置为对象(map)。'));

    if (options.portStatus === 'available') {
        checks.push(createCheck('PORT_AVAILABLE', 'ok', '监听端口可用'));
    } else if (options.portStatus === 'occupied') {
        checks.push(createCheck('PORT_OCCUPIED', 'warning', '监听端口已占用', '选择其他 serve 端口或停止占用进程。'));
    } else {
        checks.push(createCheck('PORT_NOT_CHECKED', 'warning', '未检查监听端口', '使用 doctor --port <port> 检查端口。'));
    }

    return {
        version: 1,
        runtimeCommand: runtimeCommand || null,
        runtimeSource,
        ok: !checks.some(check => check.status === 'error'),
        checks
    };
}

async function attemptFix(handler) {
    if (typeof handler !== 'function') {
        return { attempted: false, fixed: false, message: '' };
    }
    try {
        const result = await handler();
        return { attempted: true, fixed: Boolean(result && result.fixed), message: String(result && result.message || '') };
    } catch (error) {
        return { attempted: true, fixed: false, message: String(error && error.message || error).split('\n')[0] };
    }
}

/**
 * 对 runDoctorChecks 的报告执行修复：每个未通过的检查项都带 fix: {attempted, fixed, message}。
 * handlers: startRuntime / pullImage / createConfig / suggestPort，各返回 {fixed, message}。
 */
async function applyDoctorFixes(report, handlers = {}) {
    const checks = report.checks.map(check => ({ ...check }));
    const find = code => checks.find(check => check.code === code);

    const daemon = find('DAEMON_UNAVAILABLE');
    if (daemon) daemon.fix = await attemptFix(handlers.startRuntime);

    const image = find('IMAGE_MISSING');
    if (image) {
        image.fix = daemon && !daemon.fix.fixed
            ? { attempted: false, fixed: false, message: '需先修复容器运行时' }
            : await attemptFix(handlers.pullImage);
    }

    const config = find('CONFIG_MISSING');
    if (config) config.fix = await attemptFix(handlers.createConfig);

    const port = find('PORT_OCCUPIED');
    if (port) port.fix = await attemptFix(handlers.suggestPort);

    checks.forEach(check => {
        if (check.status !== 'ok' && !check.fix) {
            check.fix = { attempted: false, fixed: false, message: '' };
        }
    });

    return {
        ...report,
        ok: !checks.some(check => check.status === 'error' && !(check.fix && check.fix.fixed)),
        checks
    };
}

module.exports = {
    runDoctorChecks,
    applyDoctorFixes
};
