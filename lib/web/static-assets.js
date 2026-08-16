'use strict';

const fs = require('fs');
const path = require('path');

function collectManifestFiles(manifest) {
    const files = new Set();
    for (const entry of Object.values(manifest || {})) {
        if (!entry || typeof entry !== 'object') continue;
        [entry.file, ...(Array.isArray(entry.css) ? entry.css : []), ...(Array.isArray(entry.assets) ? entry.assets : [])]
            .filter(value => typeof value === 'string')
            .forEach(value => files.add(value));
    }
    return files;
}

function normalizeAssetPath(value) {
    const raw = String(value || '');
    if (!raw || raw.includes('%') || raw.includes('\\') || raw.startsWith('/')) {
        return null;
    }
    const normalized = path.posix.normalize(raw);
    if (normalized !== raw || normalized.startsWith('../') || normalized === '..') {
        return null;
    }
    return normalized;
}

function createStaticAssetResolver(distDir) {
    const rootDir = path.resolve(distDir);
    const manifestPath = path.join(rootDir, '.vite', 'manifest.json');

    function getManifestFiles() {
        if (!fs.existsSync(manifestPath)) {
            return new Set();
        }
        try {
            return collectManifestFiles(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
        } catch (error) {
            return new Set();
        }
    }

    return {
        resolveViteAsset(assetPath) {
            const normalizedPath = normalizeAssetPath(assetPath);
            if (!normalizedPath || !getManifestFiles().has(normalizedPath)) {
                return null;
            }
            const filePath = path.resolve(rootDir, normalizedPath);
            if (!filePath.startsWith(`${rootDir}${path.sep}`) || !fs.existsSync(filePath)) {
                return null;
            }
            return filePath;
        }
    };
}

module.exports = {
    createStaticAssetResolver
};
