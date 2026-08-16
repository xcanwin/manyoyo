'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const {
    resolveContainerMode
} = require('../lib/runtime/container-modes');
const {
    buildContainerExecArgs,
    assertProcessSucceeded
} = require('../lib/runtime/container-exec');
const { resolveYoloCommand } = require('../lib/agent-adapters/metadata');

const BIN_PATH = path.join(__dirname, '../bin/manyoyo.js');

describe('运行时契约', () => {
    test.each([
        ['common', 'common', []],
        ['docker-in-docker', 'dind', ['--privileged']],
        ['dind', 'dind', ['--privileged']],
        ['d', 'dind', ['--privileged']],
        ['mount-docker-socket', 'sock', [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ]],
        ['sock', 'sock', [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ]],
        ['s', 'sock', [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ]]
    ])('container mode %s 保持既有语义', (input, mode, args) => {
        expect(resolveContainerMode(input)).toEqual({ mode, args });
    });

    test('未知 container mode 为可处理的 validation error', () => {
        expect(() => resolveContainerMode('invalid')).toThrow('未知 containerMode: invalid');
    });

    test.each([
        ['claude', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['c', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['cc', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['gemini', 'gemini --yolo'],
        ['gm', 'gemini --yolo'],
        ['g', 'gemini --yolo'],
        ['codex', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['cx', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['opencode', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'],
        ['oc', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode']
    ])('YOLO alias %s 保持现有命令', (alias, command) => {
        expect(resolveYoloCommand(alias)).toBe(command);
    });

    test('未知 YOLO alias 为可处理的 validation error', () => {
        expect(() => resolveYoloCommand('invalid')).toThrow('未知 yolo 值: invalid');
    });

    test('根据 stdin/stdout 的 TTY 状态分别传递 -i/-t', () => {
        expect(buildContainerExecArgs('demo', 'echo ok', { stdinIsTTY: true, stdoutIsTTY: true }))
            .toEqual(['exec', '-it', 'demo', '/bin/bash', '-c', 'echo ok']);
        expect(buildContainerExecArgs('demo', 'echo ok', { stdinIsTTY: false, stdoutIsTTY: true }))
            .toEqual(['exec', '-t', 'demo', '/bin/bash', '-c', 'echo ok']);
        expect(buildContainerExecArgs('demo', 'echo ok', { stdinIsTTY: true, stdoutIsTTY: false }))
            .toEqual(['exec', '-i', 'demo', '/bin/bash', '-c', 'echo ok']);
        expect(buildContainerExecArgs('demo', '', { stdinIsTTY: true, stdoutIsTTY: false }))
            .toEqual(['exec', '-i', 'demo', '/bin/bash']);
    });

    test.each([
        [{ status: 1 }, '退出码: 1'],
        [{ status: 125 }, '退出码: 125'],
        [{ status: 126 }, '退出码: 126'],
        [{ status: 127 }, '退出码: 127'],
        [{ signal: 'SIGTERM' }, '信号: SIGTERM'],
        [{ error: new Error('spawn ENOENT') }, 'spawn ENOENT']
    ])('子进程失败必须冒泡', (result, expected) => {
        expect(() => assertProcessSucceeded(result, '容器命令执行失败')).toThrow(expected);
    });

    test('子进程成功不抛错', () => {
        expect(() => assertProcessSucceeded({ status: 0 }, '容器命令执行失败')).not.toThrow();
    });

    test.each([
        ['-y', 'not-an-agent'],
        ['-m', 'not-a-mode']
    ])('无效 CLI 配置以非 0 退出: %s %s', (option, value) => {
        const result = spawnSync(process.execPath, [BIN_PATH, 'config', 'show', option, value], {
            encoding: 'utf-8'
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Error:');
    });

    test('非 TTY 容器 exec 的非零退出码必须传递给 CLI', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-exec-status-'));
        const tempHome = path.join(tempDir, 'home');
        const fakeDockerPath = path.join(tempDir, 'docker');
        const argsLogPath = path.join(tempDir, 'docker-args.log');
        fs.mkdirSync(tempHome);
        fs.writeFileSync(fakeDockerPath, `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "ps" ]; then echo "exec-status-test"; exit 0; fi
if [ "$1" = "inspect" ]; then echo "running"; exit 0; fi
if [ "$1" = "exec" ]; then exit 126; fi
exit 0
`, { mode: 0o755 });

        try {
            const result = spawnSync(process.execPath, [
                BIN_PATH,
                'run',
                '-n', 'exec-status-test',
                '-x', 'echo ok'
            ], {
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    HOME: tempHome,
                    PATH: `${tempDir}:${process.env.PATH}`,
                    FAKE_DOCKER_LOG: argsLogPath
                }
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('退出码: 126');
            const execArgs = fs.readFileSync(argsLogPath, 'utf-8').split(/\r?\n/);
            expect(execArgs).toContain('exec');
            expect(execArgs).not.toContain('-it');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
