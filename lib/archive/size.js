'use strict';

// 目录占用的估算（du），导出前的预览与服务端算估算值共用。取不到返回 null（“大小未知”）。

const { execFile } = require('child_process');

function duBytes(dir, { timeoutMs = 5000, signal } = {}) {
    return new Promise(resolve => {
        const child = execFile('du', ['-sk', '--', dir], { timeout: timeoutMs, signal }, (error, stdout) => {
            if (error) return resolve(null);
            const kb = Number(String(stdout).split(/\s+/)[0]);
            resolve(Number.isFinite(kb) ? kb * 1024 : null);
        });
        child.on('error', () => resolve(null));
    });
}

module.exports = { duBytes };
