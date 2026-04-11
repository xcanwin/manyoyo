'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function defaultRunGitCommand(targetPath, args) {
    const result = spawnSync('git', ['-C', targetPath, ...args], {
        encoding: 'utf-8'
    });

    if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        throw new Error(stderr || `git ${args.join(' ')} 执行失败`);
    }

    return String(result.stdout || '').trim();
}

function normalizeAbsolutePath(targetPath) {
    return path.resolve(String(targetPath || '').trim());
}

function isDescendantPath(parentPath, targetPath) {
    const relativePath = path.relative(parentPath, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function detectGitWorktreeContext(targetPath, deps = {}) {
    const fsApi = deps.fs || fs;
    const pathApi = deps.path || path;
    const runGitCommand = deps.runGitCommand || defaultRunGitCommand;
    const absoluteTargetPath = normalizeAbsolutePath(targetPath);

    if (!fsApi.existsSync(absoluteTargetPath)) {
        throw new Error(`启用 --worktrees 时宿主机路径不存在: ${absoluteTargetPath}`);
    }

    const stats = fsApi.statSync(absoluteTargetPath);
    if (!stats.isDirectory()) {
        throw new Error(`启用 --worktrees 时宿主机路径必须为目录: ${absoluteTargetPath}`);
    }

    let repoRoot;
    let commonDirRaw;
    try {
        repoRoot = pathApi.resolve(runGitCommand(absoluteTargetPath, ['rev-parse', '--show-toplevel']));
        commonDirRaw = runGitCommand(absoluteTargetPath, ['rev-parse', '--git-common-dir']);
    } catch (error) {
        throw new Error(`启用 --worktrees 失败: ${absoluteTargetPath} 不在 Git 仓库内`);
    }

    const commonDir = pathApi.isAbsolute(commonDirRaw)
        ? pathApi.normalize(commonDirRaw)
        : pathApi.resolve(repoRoot, commonDirRaw);
    const mainRepoRoot = pathApi.dirname(commonDir);
    const projectName = pathApi.basename(mainRepoRoot);

    return {
        targetPath: absoluteTargetPath,
        repoRoot,
        mainRepoRoot,
        isWorktree: repoRoot !== mainRepoRoot,
        projectName,
        defaultWorktreesRoot: pathApi.join(pathApi.dirname(mainRepoRoot), 'worktrees', projectName)
    };
}

function shouldAddSamePathMount(hostPath, containerPath, targetPath) {
    if (hostPath !== containerPath) {
        return true;
    }
    return !isDescendantPath(hostPath, targetPath);
}

function resolveWorktreeSupport(options = {}, deps = {}) {
    const fsApi = deps.fs || fs;
    const pathApi = deps.path || path;
    const enabled = options.enabled === true || Boolean(options.worktreesRoot);

    if (!enabled) {
        return {
            enabled: false,
            worktreesRoot: null,
            worktreeRepoRoot: null,
            worktreeMainRepoRoot: null,
            extraVolumes: []
        };
    }

    const hostPath = normalizeAbsolutePath(options.hostPath);
    const containerPath = String(options.containerPath || hostPath).trim() || hostPath;
    const detected = detectGitWorktreeContext(hostPath, deps);
    let worktreesRoot = options.worktreesRoot;

    if (worktreesRoot !== undefined && worktreesRoot !== null && String(worktreesRoot).trim() !== '') {
        if (!pathApi.isAbsolute(worktreesRoot)) {
            throw new Error(`--worktrees-root 仅支持绝对路径: ${worktreesRoot}`);
        }
        worktreesRoot = pathApi.resolve(worktreesRoot);
    } else {
        worktreesRoot = detected.defaultWorktreesRoot;
    }

    fsApi.mkdirSync(worktreesRoot, { recursive: true });

    const existingVolumes = new Set((options.volumes || []).map(item => String(item)));
    const extraVolumes = [];
    [detected.mainRepoRoot, worktreesRoot].forEach(targetPath => {
        if (!shouldAddSamePathMount(hostPath, containerPath, targetPath)) {
            return;
        }
        const volume = `${targetPath}:${targetPath}`;
        if (existingVolumes.has(volume) || extraVolumes.includes(volume)) {
            return;
        }
        extraVolumes.push(volume);
    });

    return {
        enabled: true,
        worktreesRoot,
        worktreeRepoRoot: detected.repoRoot,
        worktreeMainRepoRoot: detected.mainRepoRoot,
        extraVolumes
    };
}

module.exports = {
    detectGitWorktreeContext,
    resolveWorktreeSupport
};
