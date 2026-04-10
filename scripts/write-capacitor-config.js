'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'capacitor.config.json');
const remoteUrl = String(process.env.MANYOYO_CAP_SERVER_URL || '').trim();

function isHttpUrl(value) {
    return /^https?:\/\/[^/\s]+/i.test(value);
}

const config = {
    appId: 'io.github.xcanwin.manyoyo.mobile',
    appName: 'MANYOYO Mobile',
    webDir: 'apps/capacitor/www',
    bundledWebRuntime: false
};

if (remoteUrl) {
    if (!isHttpUrl(remoteUrl)) {
        console.error(`MANYOYO_CAP_SERVER_URL 非法: ${remoteUrl}`);
        process.exit(1);
    }
    config.server = {
        url: remoteUrl,
        cleartext: remoteUrl.startsWith('http://')
    };
}

fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`已写入 ${CONFIG_PATH}`);
if (config.server && config.server.url) {
    console.log(`Capacitor 远程地址: ${config.server.url}`);
} else {
    console.log('Capacitor 当前使用本地说明页。');
}
