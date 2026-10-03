'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPostInstall, findOtherManyoyo, outdatedServeNotice } = require('../lib/post-install');

function makeDeps(over = {}) {
    const logs = [];
    const asked = [];
    return {
        logs, asked,
        deps: {
            headless: true, interactive: true, currentVersion: '8.2.0',
            log: line => logs.push(line),
            ask: jest.fn(async prompt => { asked.push(prompt); return over.answer === undefined ? '' : over.answer; }),
            startApp: jest.fn(async () => {}),
            runSetup: jest.fn(async () => (over.setupCode === undefined ? 0 : over.setupCode)),
            findOthers: () => over.others || [],
            listServes: () => over.serves || [],
            ...over.deps
        }
    };
}

describe('runPostInstall', () => {
    test('graphical machine: starts the web app straight away, never asks', async () => {
        const { deps } = makeDeps();
        deps.headless = false;
        expect(await runPostInstall(deps)).toBe(0);
        expect(deps.startApp).toHaveBeenCalledTimes(1);
        expect(deps.ask).not.toHaveBeenCalled();
        expect(deps.runSetup).not.toHaveBeenCalled();
    });

    test('headless without a terminal: installs only — no service, no setup, no questions — and says what to do next', async () => {
        const { deps, logs } = makeDeps();
        deps.interactive = false;
        await runPostInstall(deps);
        expect(deps.startApp).not.toHaveBeenCalled();
        expect(deps.runSetup).not.toHaveBeenCalled();
        expect(deps.ask).not.toHaveBeenCalled();
        const text = logs.join('\n');
        expect(text).toContain('没有启动任何服务');
        expect(text).toContain('manyoyo setup');
    });

    test('headless with a terminal: the default (Enter) is the terminal setup, with "[默认选1]"', async () => {
        const { deps, logs, asked } = makeDeps({ answer: '' });
        await runPostInstall(deps);
        expect(asked).toEqual(['请选择 [默认选1]: ']);
        expect(deps.runSetup).toHaveBeenCalledTimes(1);
        expect(deps.startApp).not.toHaveBeenCalled();
        const text = logs.join('\n');
        expect(text).toContain('这台机器没有图形界面，怎么完成首次配置？');
        expect(text).toContain('1) 在终端里配置（推荐）');
        expect(text).toContain('✓ 配置完成。常用命令：');
        expect(text).toContain('manyoyo serve --list');
    });

    test('choice 2 starts the web app (SSH forwarding hints come from the launcher); choice 3 starts nothing', async () => {
        let { deps } = makeDeps({ answer: '2' });
        await runPostInstall(deps);
        expect(deps.startApp).toHaveBeenCalledTimes(1);
        expect(deps.runSetup).not.toHaveBeenCalled();

        const three = makeDeps({ answer: '3' });
        await runPostInstall(three.deps);
        expect(three.deps.startApp).not.toHaveBeenCalled();
        expect(three.deps.runSetup).not.toHaveBeenCalled();
        expect(three.logs.join('\n')).toContain('没有启动任何服务');
    });

    test('an invalid answer is asked again; a failed setup says how to retry and still succeeds', async () => {
        const answers = ['x', '9', ''];
        const { deps, logs } = makeDeps({ setupCode: 1 });
        deps.ask = jest.fn(async () => answers.shift());
        expect(await runPostInstall(deps)).toBe(0);
        expect(deps.ask).toHaveBeenCalledTimes(3);
        expect(logs.join('\n')).toContain('请输入 1、2 或 3。');
        expect(logs.join('\n')).toContain('配置没有完成，之后运行 manyoyo setup 重试。');
    });

    test('input closed at the question (Ctrl-D) behaves like "3": nothing started, nothing thrown, notices still shown', async () => {
        const { deps, logs } = makeDeps({ serves: [{ pid: 1, listen: '0.0.0.0:3000', version: '7.1.6', source: 'npm', args: ['0.0.0.0:3000'] }] });
        deps.ask = jest.fn(async () => { throw new Error('输入已结束'); });
        await expect(runPostInstall(deps)).resolves.toBe(0);
        expect(deps.startApp).not.toHaveBeenCalled();
        expect(deps.runSetup).not.toHaveBeenCalled();
        expect(logs.join('\n')).toContain('没有启动任何服务');
        expect(logs.join('\n')).toContain('还在运行旧版代码');
    });

    test('notices: another manyoyo on PATH, and outdated serves with a ready restart command (password masked)', async () => {
        const { deps, logs } = makeDeps({
            answer: '3',
            others: [{ path: '/usr/local/bin/manyoyo', version: '7.1.6', source: 'npm' }],
            serves: [
                { pid: 1760430, listen: '0.0.0.0:3000', version: '7.1.6', source: 'npm', args: ['0.0.0.0:3000', '-U', 'admin', '-P', '******'], command: '' },
                { pid: 5, listen: '127.0.0.1:9', version: '8.2.0', source: 'offline', args: ['127.0.0.1:9'], command: '' }
            ]
        });
        await runPostInstall(deps);
        const text = logs.join('\n');
        expect(text).toContain('/usr/local/bin/manyoyo（7.1.6，由全局 Node 的 npm 安装）');
        expect(text).toContain('新开终端后，输入 manyoyo 会优先使用本次的 8.2.0；另一份不会被改动。');
        expect(text).not.toContain('npm uninstall');
        expect(text).toContain('0.0.0.0:3000（pid 1760430，版本 7.1.6，由全局 Node 的 npm 安装）');
        expect(text).toContain('my serve 0.0.0.0:3000 -U admin -P ****** -d --restart');
        expect(text).toContain('把 ****** 换成你原来的密码');
        expect(text).not.toContain('127.0.0.1:9'); // 已是当前版本的不提示
        // 另一份 manyoyo 的提示在选择之前，旧版 serve 的提示在最后
        expect(text.indexOf('另一份 manyoyo')).toBeLessThan(text.indexOf('怎么完成首次配置'));
        expect(text.indexOf('怎么完成首次配置')).toBeLessThan(text.indexOf('还在运行旧版代码'));
    });

    test('no notices when nothing else is installed or running', async () => {
        const { deps, logs } = makeDeps({ answer: '3' });
        await runPostInstall(deps);
        expect(logs.join('\n')).not.toContain('提示：');
    });
});

describe('findOtherManyoyo', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-others-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function npmInstall() {
        const pkg = path.join(root, 'lib', 'node_modules', '@xcanwin', 'manyoyo');
        fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), '{"version":"7.1.6"}');
        fs.writeFileSync(path.join(pkg, 'bin', 'manyoyo.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(path.join(pkg, 'bin', 'manyoyo.js'), path.join(bin, 'manyoyo'));
        return bin;
    }

    test('our own install is recognised even when the home directory is reached through a symlink', () => {
        const realHome = path.join(root, 'var', 'home', 'u');
        fs.mkdirSync(path.join(realHome, '.manyoyo', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(realHome, '.manyoyo', 'bin', 'manyoyo'), '#!/bin/sh\n', { mode: 0o755 });
        fs.mkdirSync(path.join(root, 'home'), { recursive: true });
        fs.symlinkSync(realHome, path.join(root, 'home', 'u'));
        const viaLink = path.join(root, 'home', 'u', '.manyoyo');
        expect(findOtherManyoyo({ pathEnv: path.join(viaLink, 'bin'), ownRoot: viaLink })).toEqual([]);
        // PATH 里写的是真实路径、ownRoot 是软链接路径，也认得出
        expect(findOtherManyoyo({ pathEnv: path.join(realHome, '.manyoyo', 'bin'), ownRoot: viaLink })).toEqual([]);
    });

    test('finds an npm global install with its version, ignoring our own ~/.manyoyo and duplicates', () => {
        const bin = npmInstall();
        const own = path.join(root, '.manyoyo');
        const ownBin = path.join(own, 'bin');
        fs.mkdirSync(ownBin, { recursive: true });
        fs.writeFileSync(path.join(own, 'real.js'), '', { mode: 0o755 });
        fs.symlinkSync(path.join(own, 'real.js'), path.join(ownBin, 'manyoyo'));
        const result = findOtherManyoyo({ pathEnv: [ownBin, bin, bin].join(path.delimiter), ownRoot: own, currentVersion: '8.2.0' });
        expect(result).toEqual([{ path: path.join(bin, 'manyoyo'), version: '7.1.6', source: 'npm' }]);
        expect(findOtherManyoyo({ pathEnv: path.join(root, 'nope'), ownRoot: own })).toEqual([]);
    });
});

test('outdatedServeNotice mentions no password hint when no instance had one', () => {
    const lines = outdatedServeNotice([{ pid: 1, listen: '127.0.0.1:3000', version: '7.1.6', source: 'npm', args: ['127.0.0.1:3000'] }], '8.2.0').join('\n');
    expect(lines).toContain('my serve 127.0.0.1:3000 -d --restart');
    expect(lines).not.toContain('******');
});
