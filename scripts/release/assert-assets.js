'use strict';

// 公开 Release 之前的最后一道门：草稿里的资产必须齐全，且与 SHA256SUMS 完全一致。
//   node scripts/release/assert-assets.js <tag> <version> [SIZES 目录]    （需要 GH_TOKEN；不满足退出码 1；给了目录就同时核对各平台上传时记下的文件大小）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkAssets, parseSums } = require('./facts');

/** 构建 job 记下的 SIZES-*.txt（每行：文件名 大小）→ { 文件名: 大小 } */
function readSizes(dir) {
    const sizes = {};
    for (const file of fs.readdirSync(dir).filter(name => /^SIZES-.*\.txt$/.test(name))) {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean)) {
            const [name, size] = line.trim().split(/\s+/);
            sizes[name] = Number(size);
        }
    }
    return sizes;
}

function assertReleaseAssets({ tag, version, gh, sizes = null }) {
    const view = gh(['release', 'view', tag, '--json', 'isDraft,assets']);
    if (view.status !== 0) return { ok: false, reason: `读不到 Release ${tag}` };
    const release = JSON.parse(view.stdout);
    if (release.isDraft !== true) return { ok: false, reason: `${tag} 不是草稿（已经公开，不再处理）` };
    // 上传中途中断会留下同名的残缺资产：只认已上传完成且非空的
    const unfinished = release.assets.filter(item => item.state !== 'uploaded' || !(item.size > 0)).map(item => item.name);
    if (unfinished.length > 0) return { ok: false, reason: `这些资产没有上传完成（或为空）：${unfinished.join('、')}` };
    const names = release.assets.map(item => item.name).sort();
    // 构建 job 上传时记下了每个文件的大小：草稿里的必须一模一样（名字对了但内容残缺，只比名字发现不了）
    if (sizes) {
        const actual = Object.fromEntries(release.assets.map(item => [item.name, item.size]));
        const wrong = Object.entries(sizes).filter(([name, size]) => actual[name] !== size).map(([name, size]) => `${name}（应为 ${size}，实际 ${actual[name] === undefined ? '没有' : actual[name]}）`);
        if (wrong.length > 0) return { ok: false, reason: `这些资产与构建时记录的大小不一致：${wrong.join('、')}` };
    }
    const sums = gh(['release', 'download', tag, '-p', 'SHA256SUMS', '-O', '-']);
    if (sums.status !== 0) return { ok: false, reason: `${tag} 里没有可下载的 SHA256SUMS` };
    const result = checkAssets(version, names, parseSums(sums.stdout));
    if (!result.ok) return { ok: false, reason: `资产不齐或与 SHA256SUMS 不一致：缺 ${result.missing.join('、') || '无'}；多 ${result.extra.join('、') || '无'}` };
    return { ok: true, count: names.length };
}

if (require.main === module) {
    const [tag, version, sizesDir] = process.argv.slice(2);
    if (!tag || !version) {
        console.error('用法: assert-assets.js <tag> <version> [SIZES 清单所在目录]');
        process.exit(2);
    }
    const gh = args => spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    const result = assertReleaseAssets({ tag, version, gh, sizes: sizesDir ? readSizes(sizesDir) : null });
    if (!result.ok) {
        console.error(result.reason);
        process.exit(1);
    }
    console.log(`${tag}: 资产齐全（${result.count} 个，与 SHA256SUMS 一致）`);
}

module.exports = { assertReleaseAssets, readSizes };
