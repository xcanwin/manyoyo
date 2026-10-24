'use strict';

const { serveDirOf, listServeDir } = require('./serve-dir-guard');

module.exports = async () => {
    globalThis.__manyoyoServeDirBefore = listServeDir(serveDirOf());
};
