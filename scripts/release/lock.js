'use strict';

// 单实例锁：网页控制台与命令行可能是两个进程，同一时间只允许一个在跑发布任务。
// 锁文件记录持有者 pid；持有者已不存在（kill -9、崩溃）时视为陈旧，直接接管。

const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/**
 * @returns {() => void} 释放函数
 * @throws 已有存活的持有者时抛出 { code: 'BUSY' } 的错误（由调用方转成 ReleaseError）
 */
function acquireJobLock(repoRoot, label = 'release') {
    const file = path.join(repoRoot, '.release', 'job.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            fs.writeFileSync(file, body, { flag: 'wx' });
            return () => {
                try {
                    const holder = JSON.parse(fs.readFileSync(file, 'utf-8'));
                    if (holder.pid === process.pid) fs.unlinkSync(file);
                } catch (error) {
                    // 已被清理
                }
            };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let holder = {};
            try {
                holder = JSON.parse(fs.readFileSync(file, 'utf-8'));
            } catch (readError) {
                holder = {};
            }
            if (pidAlive(holder.pid) && holder.pid !== process.pid) {
                const busy = new Error(`已有发布任务在运行（pid ${holder.pid}，${holder.label || 'release'}，开始于 ${holder.at || '未知'}）`);
                busy.code = 'BUSY';
                throw busy;
            }
            try { fs.unlinkSync(file); } catch (unlinkError) { /* 竞争清理 */ }
        }
    }
    const busy = new Error('无法获得发布任务锁');
    busy.code = 'BUSY';
    throw busy;
}

module.exports = { acquireJobLock };
