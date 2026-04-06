'use strict';

const fs = require('fs');
const path = require('path');

function createPlaywrightExtensionPathManager(options = {}) {
    const plugin = options.plugin;
    const asStringArray = options.asStringArray || ((value, fallback) => fallback);
    const containerExtensionRoot = options.containerExtensionRoot || '/app/extensions';

    return {
        resolveExtensionPaths(extensionArgs = []) {
            const inputs = asStringArray(extensionArgs, []);
            const uniquePaths = [];
            const seen = new Set();

            for (const item of inputs) {
                const absPath = path.resolve(item);
                if (!fs.existsSync(absPath)) {
                    throw new Error(`扩展路径不存在: ${absPath}`);
                }
                const stat = fs.statSync(absPath);
                if (!stat.isDirectory()) {
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
        },
        resolveNamedExtensionPaths(extensionNames = []) {
            const names = asStringArray(extensionNames, []);
            const extensionRoot = path.resolve(plugin.extensionDirPath());

            return names.map(name => {
                if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
                    throw new Error(`扩展名称无效: ${name}`);
                }
                return path.join(extensionRoot, name);
            });
        },
        resolveExtensionInputs(inputOptions = {}) {
            const extensionPaths = asStringArray(inputOptions.extensionPaths, []);
            const namedPaths = this.resolveNamedExtensionPaths(inputOptions.extensionNames || []);
            return this.resolveExtensionPaths([...extensionPaths, ...namedPaths]);
        },
        sanitizeExtensionMountName(value) {
            const sanitized = String(value || '')
                .trim()
                .replace(/[^A-Za-z0-9._-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '');
            return sanitized || 'ext';
        },
        buildContainerExtensionMounts(extensionPaths = []) {
            const hostPaths = asStringArray(extensionPaths, []);
            const containerPaths = [];
            const volumeMounts = [];

            hostPaths.forEach((hostPath, idx) => {
                const safeName = this.sanitizeExtensionMountName(path.basename(hostPath));
                const containerPath = path.posix.join(containerExtensionRoot, `ext-${idx + 1}-${safeName}`);
                containerPaths.push(containerPath);
                volumeMounts.push(`${hostPath}:${containerPath}:ro`);
            });

            return { containerPaths, volumeMounts };
        }
    };
}

module.exports = {
    createPlaywrightExtensionPathManager
};
