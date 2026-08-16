'use strict';

const { extractAgentMessageFromCodexJsonl } = require('../codex-output');

const AGENT_ADAPTERS = {
    claude: {
        id: 'claude',
        aliases: ['claude', 'cc', 'c'],
        yoloCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
        resumeArg: '-r',
        promptTemplate: 'claude -p {prompt}',
        preserveCommandFlag: '--dangerously-skip-permissions',
        promptFlag: '-p'
    },
    gemini: {
        id: 'gemini',
        aliases: ['gemini', 'gm', 'g'],
        yoloCommand: 'gemini --yolo',
        resumeArg: '-r',
        promptTemplate: 'gemini -p {prompt}',
        preserveCommandFlag: '--yolo',
        promptFlag: '-p'
    },
    codex: {
        id: 'codex',
        aliases: ['codex', 'cx'],
        yoloCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
        resumeArg: 'resume',
        promptTemplate: 'codex exec --skip-git-repo-check {prompt}',
        dangerousFlag: '--dangerously-bypass-approvals-and-sandbox',
        firstTurnCommand: 'codex exec'
    },
    opencode: {
        id: 'opencode',
        aliases: ['opencode', 'oc'],
        yoloCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode',
        resumeArg: '-c',
        promptTemplate: 'opencode run {prompt}',
        preserveCommandFlag: 'OPENCODE_PERMISSION=',
        promptFlag: 'run'
    }
};

function getAgentAdapter(value) {
    const key = String(value || '').trim().toLowerCase();
    const definition = Object.values(AGENT_ADAPTERS).find(adapter => adapter.aliases.includes(key));
    if (!definition) return null;

    return {
        metadata: () => ({
            id: definition.id,
            aliases: definition.aliases.slice(),
            resumeArg: definition.resumeArg,
            yoloCommand: definition.yoloCommand,
            promptTemplate: definition.promptTemplate,
            preserveCommandFlag: definition.preserveCommandFlag || '',
            promptFlag: definition.promptFlag || '',
            dangerousFlag: definition.dangerousFlag || '',
            firstTurnCommand: definition.firstTurnCommand || '',
            capabilities: {
                yolo: true,
                resume: Boolean(definition.resumeArg),
                prompt: Boolean(definition.promptTemplate),
                interactive: true,
                firstTurn: true,
                outputParser: true,
                finalMessage: true
            }
        }),
        yoloCommand: () => definition.yoloCommand,
        buildPromptTemplate: commandText => buildAgentPromptCommandTemplate(commandText, definition.id),
        buildResumeCommand: commandText => `${String(commandText || '').trim()} ${definition.resumeArg}`.trim(),
        buildInteractiveArgv: () => [definition.id],
        buildFirstTurnArgv: prompt => buildFirstTurnArgv(definition, prompt),
        buildResumeArgv: (sessionId, prompt) => buildResumeArgv(definition, sessionId, prompt),
        parseOutput: chunk => parseAdapterOutput(definition, chunk),
        extractFinalMessage: output => extractAdapterFinalMessage(definition, output)
    };
}

function extractAdapterFinalMessage(definition, output) {
    const text = String(output || '').trim();
    if (definition.id === 'codex') {
        return extractAgentMessageFromCodexJsonl(text) || text;
    }
    return text;
}

function parseAdapterOutput(definition, chunk) {
    const text = String(chunk || '');
    const events = [{ type: 'process.stdout', data: { text } }];
    const finalMessage = extractAdapterFinalMessage(definition, text);
    if (definition.id === 'codex' && finalMessage && finalMessage !== text.trim()) {
        events.push({ type: 'agent.message.completed', data: { text: finalMessage } });
    }
    return events;
}

function buildFirstTurnArgv(definition, prompt) {
    const text = String(prompt || '');
    if (definition.id === 'codex') {
        return ['codex', 'exec', '--skip-git-repo-check', text];
    }
    if (definition.id === 'opencode') {
        return ['opencode', 'run', text];
    }
    return [definition.id, '-p', text];
}

function buildResumeArgv(definition, sessionId, prompt) {
    const id = String(sessionId || '');
    const text = String(prompt || '');
    return [definition.id, definition.resumeArg, id, text];
}

function resolveYoloCommand(yolo) {
    if (!String(yolo || '').trim()) {
        return '';
    }
    const adapter = getAgentAdapter(yolo);
    if (!adapter) {
        throw new Error(`未知 yolo 值: ${yolo}`);
    }
    return adapter.yoloCommand();
}

function listAgentMetadata() {
    return Object.values(AGENT_ADAPTERS)
        .map(adapter => getAgentAdapter(adapter.id).metadata());
}

function buildAgentPromptCommandTemplate(commandText, agentId) {
    const definition = AGENT_ADAPTERS[agentId];
    if (!definition) return '';
    const command = String(commandText || '').trim();
    if (definition.preserveCommandFlag && command.includes(definition.preserveCommandFlag)) {
        return `${command} ${definition.promptFlag} {prompt}`;
    }
    if (definition.dangerousFlag && command.includes(definition.dangerousFlag)) {
        return `${definition.firstTurnCommand} ${definition.dangerousFlag} --skip-git-repo-check {prompt}`;
    }
    return definition.promptTemplate;
}

module.exports = {
    AGENT_ADAPTERS,
    getAgentAdapter,
    listAgentMetadata,
    resolveYoloCommand,
    buildAgentPromptCommandTemplate
};
