'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试不能往开发者真实的 ~/.manyoyo/serve/ 里写东西（auth-sessions-*.json、app.json、login-tokens 等）。
// globalSetup 记下目录里的文件名，globalTeardown 比较，多出来的就报错并列出。
function serveDirOf(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'serve');
}

function listServeDir(dir) {
    try {
        return fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
}

function findLeaked(before, after) {
    const known = new Set(before);
    return after.filter(name => !known.has(name)).sort();
}

module.exports = { serveDirOf, listServeDir, findLeaked };
