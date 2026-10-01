'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 写含凭据的配置文件：文件 0600、目录 0700，临时文件 + rename 原子替换（崩溃不会留下被截断的配置）。
 * 目录只在“新建”或名为 .manyoyo 时收紧，不去改动用户指定的其它已有目录的权限。
 * @param {string} filePath
 * @param {string} data
 */
function writeConfigFileSecure(filePath, data) {
    if (typeof data !== 'string') {
        throw new TypeError('配置内容必须是字符串');
    }
    const dir = path.dirname(filePath);
    const existed = fs.existsSync(dir);
    if (!existed) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!existed || path.basename(dir) === '.manyoyo') {
        try { fs.chmodSync(dir, 0o700); } catch (e) { /* 非属主等情况忽略 */ }
    }
    let target = filePath;
    try { target = fs.realpathSync(filePath); } catch (e) { /* 新文件 */ }
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, target);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 尽力清理 */ }
        throw error;
    }
}

module.exports = { writeConfigFileSecure };
