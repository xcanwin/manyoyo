'use strict';

const {
    resolveAgentProgram,
    buildAgentResumeCommand
} = require('../agent-resume');

function normalizeAgentPromptCommandTemplate(value, sourceLabel = 'agentPromptCommand') {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value !== 'string') {
        throw new Error(`${sourceLabel} 必须是字符串`);
    }
    const text = value.trim();
    if (!text) {
        return '';
    }
    if (!text.includes('{prompt}')) {
        throw new Error(`${sourceLabel} 必须包含 {prompt} 占位符`);
    }
    if (/^codex\s+exec(?:\s|$)/.test(text) && !text.includes('--skip-git-repo-check')) {
        return text.replace(/^codex\s+exec\b/, 'codex exec --skip-git-repo-check');
    }
    return text;
}

function isAgentPromptCommandEnabled(value) {
    return typeof value === 'string' && value.includes('{prompt}') && Boolean(value.trim());
}

function quoteBashSingleValue(value) {
    const text = String(value || '');
    return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function renderAgentPromptCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const safePrompt = quoteBashSingleValue(prompt);
    return templateText.replace(/\{prompt\}/g, safePrompt);
}

function prependAgentFlags(commandText, matchPattern, flagSpecs) {
    const matched = String(commandText || '').match(matchPattern);
    if (!matched) {
        return String(commandText || '');
    }
    const prefix = matched[1] || '';
    let suffix = matched[matched.length - 1] || '';
    for (let i = flagSpecs.length - 1; i >= 0; i -= 1) {
        const spec = flagSpecs[i];
        if (!spec || !spec.flag || !(spec.pattern instanceof RegExp) || spec.pattern.test(suffix)) {
            continue;
        }
        suffix = ` ${spec.flag}${suffix}`;
    }
    return `${prefix}${suffix}`;
}

function buildCodexAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const execMatch = templateText.match(
        /^((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)codex\s+exec\b/
    );
    let codexTemplate = templateText;
    if (execMatch) {
        const prefix = execMatch[1] || '';
        const suffix = templateText.slice(execMatch[0].length);
        const hasJson = /(?:^|\s)--json(?:\s|$)/.test(suffix);
        const injectedFlags = hasJson ? '' : ' --json';
        codexTemplate = `${prefix}codex exec${injectedFlags}${suffix}`;
    }
    return codexTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(codexTemplate, prompt);
}

function buildClaudeAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const claudeTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)claude\b)(.*)$/,
        [
            { flag: '--verbose', pattern: /(?:^|\s)--verbose(?:\s|$)/ },
            { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ }
        ]
    );
    return claudeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(claudeTemplate, prompt);
}

function buildGeminiAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const geminiTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)gemini\b)(.*)$/,
        [
            { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ }
        ]
    );
    return geminiTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(geminiTemplate, prompt);
}

function buildOpenCodeAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const opencodeTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)opencode\s+run\b)(.*)$/,
        [
            { flag: '--format json', pattern: /(?:^|\s)--format(?:\s|$)/ }
        ]
    );
    return opencodeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(opencodeTemplate, prompt);
}

function buildWebAgentExecCommand(template, prompt, agentProgram) {
    switch (agentProgram) {
    case 'claude':
        return buildClaudeAgentExecCommand(template, prompt);
    case 'gemini':
        return buildGeminiAgentExecCommand(template, prompt);
    case 'codex':
        return buildCodexAgentExecCommand(template, prompt);
    case 'opencode':
        return buildOpenCodeAgentExecCommand(template, prompt);
    default:
        break;
    }
    return renderAgentPromptCommand(template, prompt);
}

function getAgentRuntimeMeta(template) {
    const normalizedTemplate = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const agentProgram = resolveAgentProgram(normalizedTemplate);
    const resumeCommand = buildAgentResumeCommand(agentProgram);
    return {
        agentProgram: agentProgram || '',
        resumeCommand: resumeCommand || '',
        resumeSupported: Boolean(resumeCommand)
    };
}

module.exports = {
    normalizeAgentPromptCommandTemplate,
    isAgentPromptCommandEnabled,
    buildWebAgentExecCommand,
    getAgentRuntimeMeta
};
