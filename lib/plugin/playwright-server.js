'use strict';

// 宿主机（或 vnc 容器内）的 Playwright 浏览器服务：用 @playwright/cli 自带的 playwright-core 启动有头浏览器并开放 WebSocket。
// 用法：node playwright-server.js <playwright-core 目录> <配置文件>，配置为 chromium.launchServer 的选项。

const fs = require('fs');

async function main() {
    const [corePath, configPath] = process.argv.slice(2);
    const options = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { chromium } = require(corePath);
    const server = await chromium.launchServer(options);
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
