'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'apps', 'electron', 'assets', 'icon.svg');
const OUTPUT_DIR = path.join(ROOT, 'apps', 'electron', 'assets');
const OUTPUTS = [
    { size: 1024, filename: 'icon-1024.png' },
    { size: 512, filename: 'icon-512.png' },
    { size: 256, filename: 'icon-256.png' }
];

async function renderIcon() {
    const svg = fs.readFileSync(SOURCE_PATH, 'utf-8');
    const browser = await chromium.launch();

    try {
        for (const target of OUTPUTS) {
            const page = await browser.newPage({
                viewport: {
                    width: target.size,
                    height: target.size
                },
                deviceScaleFactor: 1
            });
            await page.setContent(`
                <!doctype html>
                <html lang="zh-CN">
                <head>
                    <meta charset="utf-8" />
                    <style>
                        html, body {
                            margin: 0;
                            width: 100%;
                            height: 100%;
                            overflow: hidden;
                            background: transparent;
                        }
                        body > svg {
                            display: block;
                            width: 100vw;
                            height: 100vh;
                        }
                    </style>
                </head>
                <body>${svg}</body>
                </html>
            `, { waitUntil: 'load' });
            await page.screenshot({
                path: path.join(OUTPUT_DIR, target.filename),
                omitBackground: true
            });
            await page.close();
        }
    } finally {
        await browser.close();
    }
}

renderIcon().then(function () {
    console.log(`已生成 ${OUTPUTS.length} 个 Electron 图标资源`);
}).catch(function (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`生成 Electron 图标失败: ${message}`);
    if (message.includes('Executable doesn\'t exist') || message.includes('browserType.launch')) {
        console.error('请先执行: npx playwright install chromium');
    }
    process.exit(1);
});
