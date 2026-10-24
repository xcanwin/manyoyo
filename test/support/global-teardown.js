'use strict';

const { serveDirOf, listServeDir, findLeaked } = require('./serve-dir-guard');

module.exports = async () => {
    const dir = serveDirOf();
    const leaked = findLeaked(globalThis.__manyoyoServeDirBefore || [], listServeDir(dir));
    if (leaked.length) {
        throw new Error(`测试往真实的 ${dir} 里写了文件（有测试起了 serve 却没隔离 HOME，或你正好在另开终端跑 serve）:\n  ${leaked.join('\n  ')}`);
    }
};
