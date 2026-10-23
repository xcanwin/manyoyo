'use strict';

const { createImageAgentProbe } = require('../lib/image-agents');
const { classifyConnectionResult } = require('../lib/setup');

function fakeExec({ id = 'sha256:aaa', agents = 'claude\ncodex\n', runFails = false } = {}) {
    const calls = [];
    const exec = async args => {
        calls.push(args);
        if (args[0] === 'image') return `${id}\n`;
        if (runFails) throw new Error('boom');
        return agents;
    };
    return { exec, calls };
}

describe('probeImageAgents', () => {
    test('解析镜像里装了的 Agent', async () => {
        const { exec, calls } = fakeExec();
        const probe = createImageAgentProbe(exec);
        expect(await probe('img:1')).toEqual(['claude', 'codex']);
        const run = calls.find(a => a[0] === 'run');
        expect(run).toEqual(expect.arrayContaining(['--rm', '--network', 'none', '--entrypoint', '/bin/sh', 'img:1']));
    });

    test('同一镜像 ID 只探测一次（含不同标签指向同一镜像）', async () => {
        const { exec, calls } = fakeExec();
        const probe = createImageAgentProbe(exec);
        await probe('img:1');
        await probe('img:1');
        await probe('img:alias');
        expect(calls.filter(a => a[0] === 'run')).toHaveLength(1);
    });

    test('同时到来的请求共用一次探测', async () => {
        const { exec, calls } = fakeExec();
        const probe = createImageAgentProbe(exec);
        const results = await Promise.all([probe('img:1'), probe('img:1'), probe('img:1')]);
        expect(results).toEqual([['claude', 'codex'], ['claude', 'codex'], ['claude', 'codex']]);
        expect(calls.filter(a => a[0] === 'run')).toHaveLength(1);
    });

    test('失败返回 null 且不缓存', async () => {
        const failing = fakeExec({ runFails: true });
        const probe = createImageAgentProbe(failing.exec);
        expect(await probe('img:1')).toBeNull();
        expect(await probe('img:1')).toBeNull();
        expect(failing.calls.filter(a => a[0] === 'run')).toHaveLength(2);
    });

    test('忽略输出里的杂项行', async () => {
        const { exec } = fakeExec({ agents: 'warning\nclaude\nrm\n' });
        expect(await createImageAgentProbe(exec)('img:1')).toEqual(['claude']);
    });
});

describe('classifyConnectionResult missing_cli', () => {
    test('command not found 归为 missing_cli', () => {
        const r = classifyConnectionResult({ exitCode: 127, output: '/bin/bash: line 1: gemini: command not found' }, []);
        expect(r.category).toBe('missing_cli');
        expect(r.message).toContain('镜像里没有 gemini');
        expect(r.detail).toContain('command not found');
    });

    test('不认识的 agent 名也不崩', () => {
        const r = classifyConnectionResult({ exitCode: 127, output: 'xyz: not found' }, []);
        expect(r.category).toBe('missing_cli');
    });
});
