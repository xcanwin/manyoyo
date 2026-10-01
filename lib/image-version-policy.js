'use strict';

/**
 * manyoyo update 之后该用哪个镜像版本。
 * 运行时 `imageVersion` 的优先级是 配置 > 包内默认，所以全局配置里的值会盖过新版本的默认：
 * - 配置里没写：用新版本的默认；
 * - 配置里的值等于“旧版本的默认”：那是 build / doctor --fix 自动写进去的，不是用户有意固定，
 *   随新版本前进（调用方据此更新配置），否则用户会永远停在旧镜像；
 * - 其它值：用户有意固定，尊重它，只提示。
 *
 * @param {{configured?: string, previousDefault?: string, nextDefault?: string}} input
 * @returns {{imageVersion: string, advance: boolean, pinned: boolean}}
 */
function resolveUpdateImageVersion({ configured, previousDefault, nextDefault }) {
    const current = String(configured || '');
    const next = String(nextDefault || '');
    if (!current) {
        return { imageVersion: next, advance: false, pinned: false };
    }
    if (current === String(previousDefault || '') && next && current !== next) {
        return { imageVersion: next, advance: true, pinned: false };
    }
    return { imageVersion: current, advance: false, pinned: Boolean(next) && current !== next };
}

module.exports = { resolveUpdateImageVersion };
