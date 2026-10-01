'use strict';

// serve 的“有新版本”检查：每天最多问一次 GitHub Release，结果缓存在 ~/.manyoyo/serve/update-check.json。
// updateCheck=false 时完全不发请求；请求只带固定的 User-Agent，不附带任何本机信息。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareVersions } = require('./app-update');

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;

function cachePath(homeDir) {
    return path.join(homeDir, '.manyoyo', 'serve', 'update-check.json');
}

function readCache(homeDir) {
    try {
        return JSON.parse(fs.readFileSync(cachePath(homeDir), 'utf-8'));
    } catch (error) {
        return {};
    }
}

function writeCache(homeDir, data) {
    try {
        fs.mkdirSync(path.dirname(cachePath(homeDir)), { recursive: true });
        fs.writeFileSync(cachePath(homeDir), `${JSON.stringify(data)}\n`);
    } catch (error) {
        // 缓存写不进去不影响功能
    }
}

/**
 * @param {{homeDir?: string, currentVersion: string, installMode: string, enabled: boolean, fetchLatest: () => Promise<{version: string}>, now?: () => number}} options
 */
function createUpdateChecker(options) {
    const homeDir = options.homeDir || os.homedir();
    const now = options.now || Date.now;
    const enabled = options.enabled !== false;
    let inflight = null;

    function snapshot() {
        const cache = readCache(homeDir);
        const latest = typeof cache.latest === 'string' ? cache.latest : '';
        return {
            enabled,
            installMode: options.installMode,
            current: options.currentVersion,
            latest,
            updateAvailable: Boolean(latest) && compareVersions(latest, options.currentVersion) > 0,
            checkedAt: cache.checkedAt || null,
            error: cache.error || ''
        };
    }

    function isStale(cache) {
        const age = now() - (Number(cache.checkedAtMs) || 0);
        return age >= (cache.error ? FAILURE_RETRY_MS : DAY_MS);
    }

    function refresh() {
        if (inflight) return inflight;
        inflight = (async () => {
            const previous = readCache(homeDir);
            try {
                const release = await options.fetchLatest();
                writeCache(homeDir, { latest: release.version, checkedAtMs: now(), checkedAt: new Date(now()).toISOString() });
            } catch (error) {
                // 失败也记一次检查时间，别每次打开页面都去敲 GitHub；上一次成功的版本信息保留
                writeCache(homeDir, { latest: previous.latest || '', checkedAtMs: now(), checkedAt: new Date(now()).toISOString(), error: String(error.message || error).slice(0, 200) });
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    return {
        // 立即返回缓存；缓存过期就在后台刷新，不阻塞请求
        getInfo() {
            if (enabled && isStale(readCache(homeDir))) refresh();
            return snapshot();
        },
        refresh,
        snapshot
    };
}

module.exports = { createUpdateChecker, cachePath, DAY_MS, FAILURE_RETRY_MS };
