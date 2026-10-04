'use strict';

// 真实探测：连上浏览器、新开页面、打开 data: 页面并读回内容。
// 作为子进程运行，父进程负责超时；端点（含 token）只经环境变量 MANYOYO_PROBE 传入。
// MANYOYO_PROBE = { core, kind: 'ws' | 'cdp', endpoint, timeout }

async function probe({ core, kind, endpoint, timeout }) {
    const { chromium } = require(core);
    const started = Date.now();
    const browser = kind === 'cdp'
        ? await chromium.connectOverCDP(endpoint, { timeout })
        : await chromium.connect(endpoint, { timeout });
    try {
        let context;
        let ownContext = false;
        if (kind === 'cdp') {
            context = browser.contexts()[0] || await browser.newContext();
        } else {
            context = await browser.newContext();
            ownContext = true;
        }
        const page = await context.newPage();
        try {
            await page.goto('data:text/html,<title>manyoyo-ok</title>', { timeout });
            const title = await page.title();
            if (title !== 'manyoyo-ok') {
                throw new Error(`页面内容不符: ${title}`);
            }
        } finally {
            await page.close().catch(() => {});
            if (ownContext) {
                await context.close().catch(() => {});
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
    return Date.now() - started;
}

if (require.main === module) {
    probe(JSON.parse(process.env.MANYOYO_PROBE))
        .then(ms => {
            console.log(JSON.stringify({ ok: true, ms }));
            process.exit(0);
        })
        .catch(error => {
            console.log(JSON.stringify({ ok: false, error: String(error && error.message || error).split('\n')[0] }));
            process.exit(1);
        });
}

module.exports = { probe };
