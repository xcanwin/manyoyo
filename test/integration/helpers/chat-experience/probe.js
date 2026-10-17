'use strict';
/* istanbul ignore file */
// 不做覆盖率插桩：传给 page.evaluate / addInitScript 的函数按源码序列化后在浏览器里执行，插桩加进去的计数器变量在浏览器里不存在（jest --coverage 下报 cov_xxx is not defined）

// 页面探针（page.addInitScript 注入）：每帧在**绘制之后**采样消息流的滚动状态。
// 为什么要绘制之后：rAF 回调在布局之前运行，这时读到的是 ResizeObserver 补滚动之前的状态，
// 会把“内容刚变高、马上就会补回来”误报成没贴底。rAF 里再 postMessage，消息在这一帧渲染完之后才处理。
// 记录：scrollTop / 底部间距 / 被贴住的执行过程底部与视野底部的差 / 参考元素的屏幕位置 / 最近的用户输入；
// 另外统计执行过程节点被替换的次数、data-open 在用户没点的情况下变 false 的次数、layout-shift。
function probeMain() {
    const ux = {
        frames: [],
        inputs: [],
        traceRemovals: 0,
        autoCollapse: 0,
        cls: 0,
        pinned: null,
        refEl: null,
        recording: false,
        lastPointer: 0,
        loadingSeen: 0
    };
    window.__ux = ux;
    const now = () => performance.now();
    ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'].forEach(type => {
        window.addEventListener(type, () => {
            ux.inputs.push({ t: now(), type });
            if (type === 'pointerdown') ux.lastPointer = now();
        }, { capture: true, passive: true });
    });
    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput && ux.recording) ux.cls += entry.value;
            }
        }).observe({ type: 'layout-shift', buffered: false });
    } catch (e) {
        // 不支持 layout-shift 的浏览器只少一个指标
    }
    const observer = new MutationObserver(records => {
        if (!ux.recording) return;
        for (const record of records) {
            if (record.type === 'attributes' && record.attributeName === 'data-open') {
                const el = record.target;
                if (record.oldValue === 'true' && el.getAttribute('data-open') === 'false' && now() - ux.lastPointer > 500) {
                    ux.autoCollapse += 1;
                }
                continue;
            }
            record.removedNodes.forEach(node => {
                if (node.nodeType !== 1) return;
                if (node.matches('[data-trace-block]')) ux.traceRemovals += 1;
                ux.traceRemovals += node.querySelectorAll('[data-trace-block]').length;
            });
        }
    });
    const startObserver = () => observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-open'] });
    if (document.documentElement) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);

    const channel = new MessageChannel();
    channel.port1.onmessage = () => sample();
    function sample() {
        if (!ux.recording) return;
        const box = document.querySelector('[data-chat-scroll]');
        if (!box) return;
        const boxRect = box.getBoundingClientRect();
        const frame = {
            t: now(),
            top: box.scrollTop,
            sh: box.scrollHeight,
            ch: box.clientHeight,
            gap: box.scrollHeight - box.scrollTop - box.clientHeight
        };
        if (ux.pinned && ux.pinned.isConnected) {
            const rect = ux.pinned.getBoundingClientRect();
            frame.pinBottom = rect.bottom - boxRect.bottom;
            frame.pinTop = rect.top - boxRect.top;
        } else if (ux.pinned) {
            frame.pinLost = true;
        }
        if (ux.refEl && ux.refEl.isConnected) frame.refY = ux.refEl.getBoundingClientRect().top;
        else if (ux.refEl) frame.refLost = true;
        if (/正在加载完整内容/.test(box.textContent || '')) {
            ux.loadingSeen += 1;
            frame.loading = true;
        }
        ux.frames.push(frame);
    }
    function loop() {
        requestAnimationFrame(() => {
            channel.port2.postMessage(0);
            loop();
        });
    }
    loop();
    ux.start = () => {
        ux.frames = [];
        ux.inputs = [];
        ux.traceRemovals = 0;
        ux.autoCollapse = 0;
        ux.cls = 0;
        ux.loadingSeen = 0;
        ux.recording = true;
    };
    ux.stop = () => {
        ux.recording = false;
    };
    // 参考元素：视野正中那条消息（用户正在看的内容）
    ux.pickRef = () => {
        const box = document.querySelector('[data-chat-scroll]');
        const rect = box.getBoundingClientRect();
        const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        ux.refEl = el ? (el.closest('[data-trace-block]') || el) : null;
        return Boolean(ux.refEl);
    };
    ux.pinLast = () => {
        const blocks = document.querySelectorAll('[data-trace-block]');
        ux.pinned = blocks[blocks.length - 1] || null;
        return Boolean(ux.pinned);
    };
}

// 按用户动作判定一段采样。返回 { ok, problems[], stats }
function evaluate(data, { mode, fromT = 0, toT = Infinity, quietMs = 600 }) {
    const frames = data.frames.filter(f => f.t >= fromT && f.t <= toT);
    const inputs = data.inputs.filter(i => i.type !== 'pointerdown');
    const busy = t => inputs.some(i => t - i.t >= 0 && t - i.t < quietMs);
    const problems = [];
    let reversals = 0;
    let maxJump = 0;
    let offFrames = 0;
    let maxOff = 0;
    for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1];
        const cur = frames[i];
        if (busy(cur.t)) continue;
        if (mode === 'bottom') {
            if (cur.top < prev.top - 1) {
                reversals += 1;
                maxJump = Math.max(maxJump, prev.top - cur.top);
            }
            if (cur.gap > 2) {
                offFrames += 1;
                maxOff = Math.max(maxOff, cur.gap);
            }
        } else if (mode === 'pin-bottom') {
            if (cur.pinLost) {
                offFrames += 1;
                continue;
            }
            const off = Math.abs(cur.pinBottom || 0);
            if (off > 2) {
                offFrames += 1;
                maxOff = Math.max(maxOff, off);
            }
        } else if (mode === 'pin-top') {
            const off = Math.abs((cur.pinTop || 0) - (frames[0].pinTop || 0));
            if (cur.pinLost || off > 1) {
                offFrames += 1;
                maxOff = Math.max(maxOff, off);
            }
        } else if (mode === 'still') {
            if (cur.refLost) {
                offFrames += 1;
                continue;
            }
            const off = Math.abs(cur.refY - frames[0].refY);
            if (off > 1) {
                offFrames += 1;
                maxOff = Math.max(maxOff, off);
            }
        }
    }
    if (reversals) problems.push(`scrollTop 回跳 ${reversals} 次（最大 ${Math.round(maxJump)}px）`);
    if (offFrames) problems.push(`${mode} 偏离 ${offFrames}/${frames.length} 帧（最大 ${Math.round(maxOff)}px）`);
    if (data.traceRemovals) problems.push(`执行过程节点被替换 ${data.traceRemovals} 次`);
    if (data.autoCollapse) problems.push(`执行过程自己收起 ${data.autoCollapse} 次`);
    // 只算判定窗口里的：刷新页面后第一次展开要下载完整内容，那一下的加载提示是正常的
    const loading = frames.filter(f => f.loading).length;
    if (loading) problems.push(`闪过“正在加载完整内容” ${loading} 帧`);
    return { ok: problems.length === 0, problems, stats: { frames: frames.length, reversals, maxJump, offFrames, maxOff, cls: data.cls, loadingSeen: loading } };
}

module.exports = { probeSource: `(${probeMain.toString()})()`, evaluate };
