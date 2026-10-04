'use strict';

const { PlaywrightPlugin } = require('./playwright');

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// 全局配置与 runs.<name> 里的 plugins.playwright 分别传入，后者覆盖前者
function createPlaywrightPlugin(options = {}) {
    const pluginConfig = config => asObject(asObject(asObject(config).plugins).playwright);
    return new PlaywrightPlugin({
        stdout: options.stdout,
        stderr: options.stderr,
        runtime: options.runtime,
        homeDir: options.homeDir,
        globalConfig: pluginConfig(options.globalConfig),
        runConfig: pluginConfig(options.runConfig),
        rootGlobalConfig: asObject(options.globalConfig),
        rootRunConfig: asObject(options.runConfig)
    });
}

async function runPlaywrightCommand(request, options = {}) {
    return await createPlaywrightPlugin(options).run(request);
}

// 新建会话容器时要加的参数：CLI 的 run 与 Web 建会话共用这一个入口。
// 返回扁平的 run 参数数组（--env / --volume / 其余），以及要给用户看的警告；不会抛错。
async function buildContainerIntegration(options = {}) {
    const plugin = createPlaywrightPlugin(options);
    const integration = await plugin.buildContainerIntegration({
        runtimeCommand: options.runtimeCommand,
        envEntries: options.envEntries || [],
        dryRun: options.dryRun === true
    });
    return {
        envArgs: integration.env.flatMap(entry => ['--env', entry]),
        volumeArgs: integration.volumes.flatMap(volume => ['--volume', volume]),
        extraArgs: integration.extraArgs,
        warning: integration.warning
    };
}

// 把集成参数并进已有的扁平参数数组：已有的 env 不覆盖（NO_PROXY 由集成在原值上追加，故替换），volume 与其余参数去重
function mergeIntegration(runtime, integration) {
    const keyOf = entry => String(entry).split('=')[0];
    const proxyKeys = new Set(['NO_PROXY', 'no_proxy']);
    const pairs = args => {
        const out = [];
        for (let i = 0; i + 1 < args.length; i += 2) {
            out.push([args[i], args[i + 1]]);
        }
        return out;
    };
    const existingEnv = pairs(runtime.containerEnvs || []);
    const kept = existingEnv.filter(([head, value]) => !(head === '--env' && proxyKeys.has(keyOf(value))));
    const present = new Set(kept.filter(([head]) => head === '--env').map(([, value]) => keyOf(value)));
    const added = pairs(integration.envArgs).filter(([, value]) => proxyKeys.has(keyOf(value)) || !present.has(keyOf(value)));
    const append = (base, extra) => {
        const seen = new Set(pairs(base).map(pair => pair.join('\u0000')));
        const out = [...base];
        for (const pair of pairs(extra)) {
            if (!seen.has(pair.join('\u0000'))) {
                seen.add(pair.join('\u0000'));
                out.push(...pair);
            }
        }
        return out;
    };
    return {
        containerEnvs: [...kept, ...added].flat(),
        containerVolumes: append(runtime.containerVolumes || [], integration.volumeArgs),
        containerExtraArgs: append(runtime.containerExtraArgs || [], integration.extraArgs)
    };
}

module.exports = {
    buildContainerIntegration,
    mergeIntegration,
    createPlaywrightPlugin,
    runPlaywrightCommand
};
