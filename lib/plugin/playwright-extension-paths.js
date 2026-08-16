'use strict';

const fs = require('fs');
const path = require('path');

const CONTAINER_EXTENSION_ROOT = '/app/extensions';

function asStringArray(value, fallback = []) {
    if (!Array.isArray(value)) {
        return fallback;
    }
    return value.map(item => String(item || '').trim()).filter(Boolean);
}

function resolveExtensionPaths(extensionArgs = []) {
    const inputs = asStringArray(extensionArgs);
    const uniquePaths = [];
    const seen = new Set();
    for (const item of inputs) {
        const absPath = path.resolve(item);
        if (!fs.existsSync(absPath)) {
            throw new Error(`扩展路径不存在: ${absPath}`);
        }
        if (!fs.statSync(absPath).isDirectory()) {
            throw new Error(`扩展路径必须是目录: ${absPath}`);
        }
        const manifestPath = path.join(absPath, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            if (!seen.has(absPath)) {
                seen.add(absPath);
                uniquePaths.push(absPath);
            }
            continue;
        }
        const children = fs.readdirSync(absPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => path.join(absPath, dirent.name))
            .filter(child => fs.existsSync(path.join(child, 'manifest.json')));
        if (children.length === 0) {
            throw new Error(`目录下未找到扩展(manifest.json): ${absPath}`);
        }
        for (const childPath of children) {
            if (!seen.has(childPath)) {
                seen.add(childPath);
                uniquePaths.push(childPath);
            }
        }
    }
    return uniquePaths;
}

function resolveNamedExtensionPaths(extensionNames = [], extensionRoot) {
    const names = asStringArray(extensionNames);
    const root = path.resolve(extensionRoot);
    return names.map(name => {
        if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
            throw new Error(`扩展名称无效: ${name}`);
        }
        return path.join(root, name);
    });
}

function resolveExtensionInputs(options = {}) {
    const extensionPaths = asStringArray(options.extensionPaths);
    const namedPaths = resolveNamedExtensionPaths(options.extensionNames, options.extensionRoot || process.cwd());
    return resolveExtensionPaths([...extensionPaths, ...namedPaths]);
}

function buildExtensionLaunchArgs(extensionPaths) {
    const joined = extensionPaths.join(',');
    return [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
}

function sanitizeExtensionMountName(value) {
    const sanitized = String(value || '')
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return sanitized || 'ext';
}

function buildContainerExtensionMounts(extensionPaths = []) {
    const hostPaths = asStringArray(extensionPaths);
    const containerPaths = [];
    const volumeMounts = [];
    hostPaths.forEach((hostPath, index) => {
        const safeName = sanitizeExtensionMountName(path.basename(hostPath));
        const containerPath = path.posix.join(CONTAINER_EXTENSION_ROOT, `ext-${index + 1}-${safeName}`);
        containerPaths.push(containerPath);
        volumeMounts.push(`${hostPath}:${containerPath}:ro`);
    });
    return { containerPaths, volumeMounts };
}

module.exports = {
    CONTAINER_EXTENSION_ROOT,
    buildContainerExtensionMounts,
    buildExtensionLaunchArgs,
    resolveExtensionInputs,
    resolveExtensionPaths,
    resolveNamedExtensionPaths,
    sanitizeExtensionMountName
};
