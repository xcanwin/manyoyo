'use strict';

async function handleMetaAgentsRequest(res, dependencies) {
    dependencies.sendJson(res, 200, { agents: dependencies.listAgentMetadata() });
}

async function handleDoctorRequest(res, ctx, state, dependencies) {
    const snapshot = dependencies.readWebConfigSnapshot(state.webConfigPath);
    const config = snapshot.parseError ? {} : snapshot.parsed;
    const report = dependencies.runDoctorChecks({
        runCommand: (command, args) => {
            if (command !== ctx.dockerCmd) {
                throw new Error(`未配置运行时: ${command}`);
            }
            return ctx.dockerExecArgs(args, { stdio: 'pipe' });
        },
        runtimeCandidates: [ctx.dockerCmd],
        configExists: snapshot.exists && !snapshot.parseError,
        imageName: ctx.imageName,
        imageVersion: ctx.imageVersion,
        agentCommand: dependencies.buildDefaultCommand(ctx.execCommandPrefix, ctx.execCommand, ctx.execCommandSuffix),
        containerMode: 'common',
        pluginConfig: config.plugins
    });
    dependencies.sendJson(res, 200, report);
}

module.exports = {
    handleDoctorRequest,
    handleMetaAgentsRequest
};
