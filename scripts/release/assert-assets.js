'use strict';

// 公开 Release 之前的最后一道门：草稿里的资产必须齐全，且与 SHA256SUMS 完全一致。
//   node scripts/release/assert-assets.js <tag> <version>    （需要 GH_TOKEN；不满足退出码 1）

const { spawnSync } = require('child_process');
const { checkAssets, parseSums } = require('./facts');

function assertReleaseAssets({ tag, version, gh }) {
    const view = gh(['release', 'view', tag, '--json', 'isDraft,assets']);
    if (view.status !== 0) return { ok: false, reason: `读不到 Release ${tag}` };
    const release = JSON.parse(view.stdout);
    if (release.isDraft !== true) return { ok: false, reason: `${tag} 不是草稿（已经公开，不再处理）` };
    const names = release.assets.map(item => item.name).sort();
    const sums = gh(['release', 'download', tag, '-p', 'SHA256SUMS', '-O', '-']);
    if (sums.status !== 0) return { ok: false, reason: `${tag} 里没有可下载的 SHA256SUMS` };
    const result = checkAssets(version, names, parseSums(sums.stdout));
    if (!result.ok) return { ok: false, reason: `资产不齐或与 SHA256SUMS 不一致：缺 ${result.missing.join('、') || '无'}；多 ${result.extra.join('、') || '无'}` };
    return { ok: true, count: names.length };
}

if (require.main === module) {
    const [tag, version] = process.argv.slice(2);
    if (!tag || !version) {
        console.error('用法: assert-assets.js <tag> <version>');
        process.exit(2);
    }
    const gh = args => spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    const result = assertReleaseAssets({ tag, version, gh });
    if (!result.ok) {
        console.error(result.reason);
        process.exit(1);
    }
    console.log(`${tag}: 资产齐全（${result.count} 个，与 SHA256SUMS 一致）`);
}

module.exports = { assertReleaseAssets };
