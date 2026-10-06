'use strict';

// Agent 一轮对话进行中，容器里有新的域名被过滤代理拦下时，立即在对话里提示一次（同一域名同一轮只提示一次）。
// 只轮询拦截记录文件（每 2 秒读一个小文件），不写任何日志。
const DEFAULT_INTERVAL_MS = 2000;

/**
 * @param {object} options
 * @param {() => {host: string, port: number, count: number}[]} options.read 当前拦截记录
 * @param {(host: string) => boolean} options.isIgnored 不提示的域名（已放行、浏览器后台请求）
 * @param {(text: string) => void} options.emit
 */
function createDeniedNotifier(options) {
    const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    const baseline = new Map();
    const notified = new Set();
    let timer = null;

    function snapshot() {
        try { return options.read() || []; } catch (e) { return []; }
    }

    // 在定时器里跑：任何异常（含 emit 里写历史失败）都不能冒泡成 uncaughtException 把 serve 打挂
    function tick() {
        try {
            snapshot().forEach(record => {
                const key = `${record.host}:${record.port}`;
                if (record.count > (baseline.get(key) || 0) && !notified.has(record.host) && !options.isIgnored(record.host)) {
                    notified.add(record.host);
                    options.emit(`[提示] 已拦截：${record.host}（不在白名单），可在「容器 → 网络」里一键允许`);
                }
                baseline.set(key, record.count);
            });
        } catch (e) { /* 下一轮再试 */ }
    }

    return {
        start() {
            snapshot().forEach(record => baseline.set(`${record.host}:${record.port}`, record.count));
            timer = setInterval(tick, intervalMs);
            if (timer.unref) timer.unref();
        },
        tick,
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            tick(); // 最后一次：对话结束前的拦截也提示
        }
    };
}

module.exports = { createDeniedNotifier };
