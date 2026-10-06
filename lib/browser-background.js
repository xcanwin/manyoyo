'use strict';

const { domainAllowed } = require('./network-policy');

// 容器里的 Chrome 启动后会自己连一些谷歌的后台服务（更新、账号同步、字体 / 资源）。白名单下它们必然被拦，
// 对用户没有意义：网络分区的“最近被拦截”把它们折叠成“浏览器后台请求”，对话里也不为它们提示。
// 数据只写在这一处。
const BROWSER_BACKGROUND_DOMAINS = [
    'accounts.google.com',
    'update.googleapis.com',
    'www.google.com',
    'www.gstatic.com',
    'dl.google.com',
    'clients2.google.com',
    'android.clients.google.com',
    'content-autofill.googleapis.com'
];

function isBrowserBackground(host) {
    return domainAllowed(BROWSER_BACKGROUND_DOMAINS, host);
}

module.exports = { BROWSER_BACKGROUND_DOMAINS, isBrowserBackground };
