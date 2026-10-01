'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * 下载并校验 SHA256。缓存命中（文件存在且哈希一致）直接复用；
 * 哈希不符一律删除并报错，绝不保留不可信文件。
 */
async function downloadVerified({ url, sha256, dest, fetchImpl = fetch, log = () => {} }) {
    if (!/^[0-9a-f]{64}$/.test(sha256 || '')) {
        throw new Error(`缺少有效的 SHA256: ${url}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && await sha256File(dest) === sha256) {
        log(`缓存命中: ${path.basename(dest)}`);
        return dest;
    }
    log(`下载: ${url}`);
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`下载失败 (${response.status}): ${url}`);
    }
    const partial = `${dest}.partial`;
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
    const actual = await sha256File(partial);
    if (actual !== sha256) {
        fs.rmSync(partial, { force: true });
        throw new Error(`SHA256 校验失败: ${path.basename(dest)}（期望 ${sha256}，实际 ${actual}）`);
    }
    fs.renameSync(partial, dest);
    return dest;
}

module.exports = { sha256File, downloadVerified };
