'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectGitWorktreeContext } = require('../lib/worktrees');

describe('worktrees host tool checks', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-wt-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('darwin without Xcode CLT reports the requirement and never calls git', () => {
        const runGitCommand = jest.fn();
        expect(() => detectGitWorktreeContext(dir, {
            platform: 'darwin',
            runCommand: () => ({ status: 2 }),
            runGitCommand
        })).toThrow(/Xcode 命令行工具.*xcode-select --install/);
        expect(runGitCommand).not.toHaveBeenCalled();
    });

    test('darwin where xcode-select itself cannot run is treated as missing', () => {
        expect(() => detectGitWorktreeContext(dir, {
            platform: 'darwin',
            runCommand: () => ({ error: new Error('ENOENT') }),
            runGitCommand: jest.fn()
        })).toThrow(/Xcode 命令行工具/);
    });

    test('darwin with CLT installed proceeds to git', () => {
        const runGitCommand = jest.fn()
            .mockReturnValueOnce(dir)
            .mockReturnValueOnce(path.join(dir, '.git'));
        const runCommand = jest.fn(() => ({ status: 0 }));
        const context = detectGitWorktreeContext(dir, { platform: 'darwin', runCommand, runGitCommand });
        expect(runCommand).toHaveBeenCalledWith('xcode-select', ['-p']);
        expect(context.repoRoot).toBe(dir);
    });

    test('non-darwin platforms do not probe xcode-select', () => {
        const runCommand = jest.fn();
        const runGitCommand = jest.fn()
            .mockReturnValueOnce(dir)
            .mockReturnValueOnce(path.join(dir, '.git'));
        detectGitWorktreeContext(dir, { platform: 'linux', runCommand, runGitCommand });
        expect(runCommand).not.toHaveBeenCalled();
    });
});
