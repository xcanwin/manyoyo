'use strict';

const { resolveContainerMode } = require('./runtime/container-modes');
const { resolveAgentProgram } = require('./agent-resume');

function createCheck(code, status, summary, action = '', detail = '') {
    return { code, status, summary, action, detail };
}

function runDoctorChecks(options = {}) {
    const checks = [];
    const runCommand = typeof options.runCommand === 'function' ? options.runCommand : () => {
        throw new Error('未配置命令执行器');
    };
    let runtimeCommand = '';

    for (const candidate of (options.runtimeCandidates || ['docker', 'podman'])) {
        try {
            const detail = String(runCommand(candidate, ['--version']) || '').trim();
            runtimeCommand = candidate;
            checks.push(createCheck('RUNTIME_AVAILABLE', 'ok', `检测到 ${candidate}`, '', detail));
            break;
        } catch (error) {
            // 尝试下一个受支持运行时。
        }
    }
    if (!runtimeCommand) {
        checks.push(createCheck('RUNTIME_UNAVAILABLE', 'error', '未找到 Docker 或 Podman', '安装并启动 Docker Desktop 或 Podman。'));
    } else {
        try {
            const detail = String(runCommand(runtimeCommand, ['info']) || '').trim();
            checks.push(createCheck('DAEMON_AVAILABLE', 'ok', `${runtimeCommand} daemon 可用`, '', detail));
        } catch (error) {
            checks.push(createCheck('DAEMON_UNAVAILABLE', 'error', `${runtimeCommand} daemon 不可用`, `启动 ${runtimeCommand} daemon 后重试。`, error.message || ''));
        }
        try {
            const image = `${options.imageName || ''}:${options.imageVersion || ''}`;
            const detail = String(runCommand(runtimeCommand, ['image', 'inspect', image]) || '').trim();
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
        ok: !checks.some(check => check.status === 'error'),
        checks
    };
}

module.exports = {
    runDoctorChecks
};
