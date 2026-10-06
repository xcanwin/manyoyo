'use strict';

const fs = require('fs');
const path = require('path');

// 发布产物隐私扫描（scripts/scan-release-artifacts.js）会把 `/home/<名字>`、`/Users/<名字>` 当成本机路径；
// 前端源码里的占位符 / 示例不要写这种路径（曾因 placeholder="/home/me/…" 让四个平台的安装包构建失败）
const SRC = path.join(__dirname, '..', 'frontend', 'src');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

test('前端源码里没有 /home/<名字> 或 /Users/<名字> 形式的字面量', () => {
    const offenders = walk(SRC)
        .filter(file => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
        .filter(file => /\/(?:Users|home)\/[A-Za-z0-9._-]{1,64}/.test(fs.readFileSync(file, 'utf-8')))
        .map(file => path.relative(SRC, file));
    expect(offenders).toEqual([]);
});
