'use strict';

// 宿主机（或 vnc 容器内）的 Playwright 浏览器服务：用 patchright-core 启动有头浏览器（Google Chrome 优先）并开放 WebSocket。
// 用法：node playwright-server.js <playwright-core 目录> <配置文件>，配置为 chromium.launchServer 的选项。

const fs = require('fs');

// 官方 Google Chrome 忽略 --load-extension，改用 CDP Extensions.loadUnpacked；加载后的扩展在连接断开后仍保留
async function loadExtensions(chromium, endpoint, extensionPaths) {
    const browser = await chromium.connect(endpoint);
    try {
        const cdp = await browser.newBrowserCDPSession();
        for (const extensionPath of extensionPaths) {
            try {
                await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
            } catch (error) {
                console.error(`扩展加载失败 ${extensionPath}: ${String(error && error.message || error).split('\n')[0]}`);
            }
        }
    } finally {
        await browser.close();
    }
}

async function main() {
    const [corePath, configPath] = process.argv.slice(2);
    const { extensionPaths = [], ...options } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { chromium } = require(corePath);
    const server = await chromium.launchServer(options);
    if (extensionPaths.length > 0) {
        await loadExtensions(chromium, server.wsEndpoint(), extensionPaths);
    }
    const shutdown = () => server.close().finally(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    server.process().on('exit', () => process.exit(1));
    console.log('ready');
}

main().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
});
