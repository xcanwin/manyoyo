'use strict';

async function bootstrapFirstRun(options = {}) {
    if (options.action !== 'run' || options.configExists) {
        return false;
    }
    const initialize = typeof options.initialize === 'function' ? options.initialize : async () => {};
    const log = typeof options.log === 'function' ? options.log : () => {};
    log('🧭 检测到首次运行，正在自动初始化 Agent 配置…');
    await initialize();
    log('✅ 首次配置已创建，继续启动容器。');
    return true;
}

module.exports = { bootstrapFirstRun };
