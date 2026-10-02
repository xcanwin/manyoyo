'use strict';

const fs = require('fs');
const path = require('path');
const { sha256File } = require('../../lib/download-verified');

// 目录里所有文件的清单（相对路径、大小、SHA256、是否可执行），按路径排序，结果可复现
async function inventoryDir(rootDir, { exclude = [] } = {}) {
    const items = [];
    const walk = async (dir, prefix) => {
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const relative = prefix ? `${prefix}/${name}` : name;
            if (exclude.includes(relative)) continue;
            const stat = fs.lstatSync(full);
            if (stat.isDirectory()) {
                await walk(full, relative);
            } else if (stat.isSymbolicLink()) {
                items.push({ path: relative, symlink: fs.readlinkSync(full) });
            } else if (stat.isFile()) {
                items.push({ path: relative, size: stat.size, sha256: await sha256File(full), executable: (stat.mode & 0o111) !== 0 });
            }
        }
    };
    await walk(rootDir, '');
    return items;
}

function buildManifest({ version, imageVersion, arch, kind, components, files, builtAt, platform = 'macos' }) {
    const manifest = {
        schemaVersion: 1,
        name: 'manyoyo',
        version,
        imageVersion,
        os: platform,
        arch,
        kind,
        components,
        files
    };
    // 只在显式提供时写入时间（如取自 SOURCE_DATE_EPOCH），默认不写，保证同样输入得到同样产物
    if (builtAt) manifest.builtAt = builtAt;
    return manifest;
}

function formatSha256Sums(entries) {
    return `${entries.map(entry => `${entry.sha256}  ${entry.name}`).join('\n')}\n`;
}

module.exports = { inventoryDir, buildManifest, formatSha256Sums };
