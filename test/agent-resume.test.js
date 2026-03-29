const {
    resolveAgentProgram,
    resolveAgentResumeArg,
    buildAgentResumeCommand,
    resolveAgentPromptCommandTemplate
} = require('../lib/agent-resume');

describe('Agent Program Resolver', () => {
    test('should resolve codex from env wrapper', () => {
        expect(resolveAgentProgram('env FOO=bar codex --help')).toBe('codex');
    });

    test('should resolve basename from absolute path', () => {
        expect(resolveAgentProgram('/usr/local/bin/claude --version')).toBe('claude');
    });
});

describe('Agent Resume Arg Mapping', () => {
    test('claude command should map to -r', () => {
        expect(resolveAgentResumeArg('IS_SANDBOX=1 claude --dangerously-skip-permissions')).toBe('-r');
    });

    test('gemini command should map to -r', () => {
        expect(resolveAgentResumeArg('gemini --yolo')).toBe('-r');
    });

    test('codex command should map to resume', () => {
        expect(resolveAgentResumeArg('codex --dangerously-bypass-approvals-and-sandbox')).toBe('resume');
    });

    test('opencode command should map to -c', () => {
        expect(resolveAgentResumeArg('OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode')).toBe('-c');
    });

    test('wrapped env command should still detect agent', () => {
        expect(resolveAgentResumeArg('env FOO=bar codex --help')).toBe('resume');
    });

    test('absolute command path should detect basename', () => {
        expect(resolveAgentResumeArg('/usr/local/bin/codex --help')).toBe('resume');
    });

    test('non-agent command should return empty string', () => {
        expect(resolveAgentResumeArg('python app.py')).toBe('');
    });

    test('id command should return empty string', () => {
        expect(resolveAgentResumeArg('id')).toBe('');
    });

    test('empty command should return empty string', () => {
        expect(resolveAgentResumeArg('')).toBe('');
    });
});

describe('Agent Resume Command Builder', () => {
    test('should append claude resume arg', () => {
        expect(buildAgentResumeCommand('IS_SANDBOX=1 claude --dangerously-skip-permissions')).toBe('IS_SANDBOX=1 claude --dangerously-skip-permissions -r');
    });

    test('should append codex resume arg', () => {
        expect(buildAgentResumeCommand('codex --dangerously-bypass-approvals-and-sandbox')).toBe('codex --dangerously-bypass-approvals-and-sandbox resume');
    });

    test('non-agent command should return empty string', () => {
        expect(buildAgentResumeCommand('npm test')).toBe('');
    });
});

describe('Agent Prompt Template Resolver', () => {
    test('should map claude command to prompt template', () => {
        expect(resolveAgentPromptCommandTemplate('IS_SANDBOX=1 claude --dangerously-skip-permissions')).toBe('claude -p {prompt}');
    });

    test('should map codex command to prompt template', () => {
        expect(resolveAgentPromptCommandTemplate('codex --dangerously-bypass-approvals-and-sandbox')).toBe('codex exec --skip-git-repo-check {prompt}');
    });

    test('non-agent command should return empty template', () => {
        expect(resolveAgentPromptCommandTemplate('npm test')).toBe('');
    });
});
