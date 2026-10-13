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

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class RetryableError extends Error {}

/**
 * 下载并校验 SHA256。缓存命中（文件存在且哈希一致）直接复用；
 * 哈希不符一律删除并报错，绝不保留不可信文件。
 * 5xx / 429 / 网络错误（含下载中途断开）按 1s、2s、4s 退避，最多重试 retries 次；4xx 与哈希不符不重试。
 */
async function downloadVerified({ url, sha256, dest, fetchImpl = fetch, log = () => {}, retries = 3, retryDelayMs = 1000 }) {
    if (!/^[0-9a-f]{64}$/.test(sha256 || '')) {
        throw new Error(`缺少有效的 SHA256: ${url}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && await sha256File(dest) === sha256) {
        log(`缓存命中: ${path.basename(dest)}`);
        return dest;
    }
    const partial = `${dest}.partial`;
    for (let attempt = 0; ; attempt += 1) {
        try {
            await fetchOnce({ url, partial, fetchImpl, log });
            break;
        } catch (error) {
            fs.rmSync(partial, { force: true });
            const retryable = error instanceof RetryableError || !(error && error.status);
            if (!retryable || attempt >= retries) throw error instanceof RetryableError ? error.cause : error;
            const wait = retryDelayMs * (2 ** attempt);
            log(`下载失败，${wait / 1000} 秒后重试（${attempt + 1}/${retries}）: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }
    const actual = await sha256File(partial);
    if (actual !== sha256) {
        fs.rmSync(partial, { force: true });
        throw new Error(`SHA256 校验失败: ${path.basename(dest)}（期望 ${sha256}，实际 ${actual}）`);
    }
    fs.renameSync(partial, dest);
    return dest;
}

async function fetchOnce({ url, partial, fetchImpl, log }) {
    log(`下载: ${url}`);
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        const error = Object.assign(new Error(`下载失败 (${response.status}): ${url}`), { status: response.status });
        if (RETRYABLE_STATUS.has(response.status)) throw Object.assign(new RetryableError(error.message), { cause: error });
        throw error;
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
}

module.exports = { sha256File, downloadVerified };
