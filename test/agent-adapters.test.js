'use strict';

const {
    getAgentAdapter,
    resolveYoloCommand,
    buildAgentPromptCommandTemplate
} = require('../lib/agent-adapters');

describe('Agent adapter registry', () => {
    test('keeps an omitted yolo setting as an empty command', () => {
        expect(resolveYoloCommand('')).toBe('');
    });

    test.each([
        ['claude', 'c', '-r', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['gemini', 'gm', '-r', 'gemini --yolo'],
        ['codex', 'cx', 'resume', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['opencode', 'oc', '-c', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode']
    ])('%s exposes aliases, resume and YOLO metadata', (id, alias, resumeArg, yoloCommand) => {
        const adapter = getAgentAdapter(alias);

        expect(adapter.metadata()).toEqual(expect.objectContaining({
            id,
            aliases: expect.arrayContaining([alias]),
            resumeArg,
            yoloCommand,
            promptTemplate: expect.stringContaining(id),
            capabilities: expect.objectContaining({ outputParser: true, finalMessage: true })
        }));
        expect(resolveYoloCommand(alias)).toBe(yoloCommand);
    });

    test('preserves flags when building a first-turn command template', () => {
        expect(buildAgentPromptCommandTemplate(
            'codex --dangerously-bypass-approvals-and-sandbox',
            'codex'
        )).toBe('codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}');
    });

    test('unknown adapters are not inferred', () => {
        expect(getAgentAdapter('npm')).toBeNull();
    });

    test.each([
        ['claude', ['claude', '-p', 'hello'], ['claude', '-r', 'session-1', 'hello']],
        ['gemini', ['gemini', '-p', 'hello'], ['gemini', '-r', 'session-1', 'hello']],
        ['codex', ['codex', 'exec', '--skip-git-repo-check', 'hello'], ['codex', 'resume', 'session-1', 'hello']],
        ['opencode', ['opencode', 'run', 'hello'], ['opencode', '-c', 'session-1', 'hello']]
    ])('%s exposes first-turn, resume and output adapter operations', (id, firstTurnArgv, resumeArgv) => {
        const adapter = getAgentAdapter(id);

        expect(adapter.buildInteractiveArgv()).toEqual([id]);
        expect(adapter.buildFirstTurnArgv('hello')).toEqual(firstTurnArgv);
        expect(adapter.buildResumeArgv('session-1', 'hello')).toEqual(resumeArgv);
        expect(adapter.parseOutput('chunk')).toEqual([
            expect.objectContaining({ type: 'process.stdout', data: { text: 'chunk' } })
        ]);
        expect(adapter.extractFinalMessage('  final message  ')).toBe('final message');
    });

    test('codex adapter extracts the final message from JSONL output', () => {
        const adapter = getAgentAdapter('codex');
        const output = [
            JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'ignored' } }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } })
        ].join('\n');

        expect(adapter.extractFinalMessage(output)).toBe('final answer');
        expect(adapter.parseOutput(output)).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'agent.message.completed', data: { text: 'final answer' } })
        ]));
    });
});
