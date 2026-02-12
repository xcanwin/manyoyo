const { resolveAgentResumeArg, buildAgentResumeCommand } = require('../lib/agent-resume');

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
