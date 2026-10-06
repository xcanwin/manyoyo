'use strict';

// 容器 id：随机 16 位十六进制，状态目录、过滤代理的映射与拒绝记录都按它索引。
// 单独成文件：过滤代理 sidecar 里只带得动这几个无依赖的小文件。
const ID_RE = /^[0-9a-f]{16}$/;

function isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

module.exports = { ID_RE, isValidId };
