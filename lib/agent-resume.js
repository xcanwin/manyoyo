'use strict';

const path = require('path');

const AGENT_RESUME_ARG_MAP = {
    claude: '-r',
    gemini: '-r',
    codex: 'resume',
    opencode: '-c'
};

const AGENT_PROMPT_TEMPLATE_MAP = {
    claude: 'claude -p {prompt}',
    gemini: 'gemini -p {prompt}',
    codex: 'codex exec --skip-git-repo-check {prompt}',
    opencode: 'opencode run {prompt}'
};

const CLAUDE_DANGEROUS_FLAG = '--dangerously-skip-permissions';
const GEMINI_YOLO_FLAG = '--yolo';
const CODEX_DANGEROUS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const OPENCODE_PERMISSION_KEY = 'OPENCODE_PERMISSION=';

function stripLeadingAssignments(commandText) {
    let rest = String(commandText || '').trim();
    const assignmentPattern = /^(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)(?:\s+|$)/;

    while (rest) {
        const matched = rest.match(assignmentPattern);
        if (!matched) {
            break;
        }
        rest = rest.slice(matched[0].length).trim();
    }

    return rest;
}

function readLeadingToken(commandText) {
    const text = String(commandText || '').trim();
    if (!text) {
        return { token: '', rest: '' };
    }

    const tokenMatch = text.match(/^(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+))(?:\s+|$)/);
    if (!tokenMatch) {
        return { token: '', rest: '' };
    }

    const token = tokenMatch[1] || tokenMatch[2] || tokenMatch[3] || '';
    const rest = text.slice(tokenMatch[0].length).trim();
    return { token, rest };
}

function normalizeProgramName(token) {
    if (!token) {
        return '';
    }
    return path.basename(token).toLowerCase();
}

function resolveAgentProgram(commandText) {
    let rest = stripLeadingAssignments(commandText);
    let leading = readLeadingToken(rest);
    let program = normalizeProgramName(leading.token);

    // Support common wrapper: env KEY=VALUE cmd ...
    if (program === 'env') {
        rest = stripLeadingAssignments(leading.rest);
        leading = readLeadingToken(rest);
        program = normalizeProgramName(leading.token);
    }

    return program;
}

function resolveAgentResumeArg(commandText) {
    const program = resolveAgentProgram(commandText);
    return AGENT_RESUME_ARG_MAP[program] || '';
}

function resolveAgentPromptCommandTemplate(commandText) {
    const normalizedCommand = String(commandText || '').trim();
    const program = resolveAgentProgram(commandText);
    const template = AGENT_PROMPT_TEMPLATE_MAP[program] || '';
    if (program === 'claude' && normalizedCommand.includes(CLAUDE_DANGEROUS_FLAG)) {
        return `${normalizedCommand} -p {prompt}`;
    }
    if (program === 'gemini' && normalizedCommand.includes(GEMINI_YOLO_FLAG)) {
        return `${normalizedCommand} -p {prompt}`;
    }
    if (program === 'codex' && template) {
        if (normalizedCommand.includes(CODEX_DANGEROUS_FLAG)) {
            return `codex exec ${CODEX_DANGEROUS_FLAG} --skip-git-repo-check {prompt}`;
        }
    }
    if (program === 'opencode' && normalizedCommand.includes(OPENCODE_PERMISSION_KEY)) {
        return `${normalizedCommand} run {prompt}`;
    }
    return template;
}

function buildAgentResumeCommand(commandText) {
    const baseCommand = String(commandText || '').trim();
    if (!baseCommand) {
        return '';
    }
    const resumeArg = resolveAgentResumeArg(baseCommand);
    if (!resumeArg) {
        return '';
    }
    return `${baseCommand} ${resumeArg}`;
}

module.exports = {
    resolveAgentProgram,
    resolveAgentResumeArg,
    buildAgentResumeCommand,
    resolveAgentPromptCommandTemplate
};
