'use strict';

// 浏览器指纹的唯一数据源：宿主机生成的配置与镜像内的 docker/res/playwright/* 都从这里生成。
// 原则是各项信号自洽：UA、Client Hints、平台、字体、WebGL 一律用浏览器真实值，不做自相矛盾的伪装；
// 只固定语言、时区、窗口形态与自动化痕迹。

const CONTAINER_CONFIG_DIR = '/run/manyoyo-playwright';
const CONTAINER_CONFIG_PATH = `${CONTAINER_CONFIG_DIR}/config.json`;
const CONTAINER_INIT_SCRIPT_PATH = `${CONTAINER_CONFIG_DIR}/stealth.init.js`;
const CONTAINER_OUTPUT_DIR = '/tmp/.playwright-cli';

const DEFAULT_PROFILE = {
    locale: 'en-US',
    timezoneId: 'UTC',
    navigatorPlatform: '',
    disableWebRTC: false
};

function resolveProfile(options = {}) {
    const text = (value, fallback) => String(value || '').trim() || fallback;
    return {
        locale: text(options.locale, DEFAULT_PROFILE.locale),
        timezoneId: text(options.timezoneId, DEFAULT_PROFILE.timezoneId),
        navigatorPlatform: text(options.navigatorPlatform, DEFAULT_PROFILE.navigatorPlatform),
        disableWebRTC: options.disableWebRTC === true
    };
}

function acceptLanguage(locale) {
    const language = String(locale).split('-')[0];
    return language === locale ? `${locale};q=0.9` : `${locale},${language};q=0.9`;
}

// 宿主机的时区与系统语言，作为默认值
function detectHostProfile() {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return { locale: resolved.locale, timezoneId: resolved.timeZone };
}

// window: 'virtual' 为容器内 1920x1080 虚拟屏；'native' 为真实桌面，最大化即可
function buildLaunchArgs(options = {}, window = 'native') {
    const profile = resolveProfile(options);
    const args = [
        `--lang=${profile.locale}`,
        window === 'virtual' ? '--window-size=1920,1080' : '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
    ];
    if (profile.disableWebRTC) {
        args.push('--disable-webrtc');
    }
    return args;
}

// 有头浏览器不设置 viewport / screen，让窗口尺寸与屏幕尺寸像真实窗口一样不同
function buildContextOptions(options = {}) {
    const profile = resolveProfile(options);
    return {
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        viewport: null,
        extraHTTPHeaders: {
            'Accept-Language': acceptLanguage(profile.locale)
        }
    };
}

function buildInitScript(options = {}) {
    const profile = resolveProfile(options);
    // 首个页面加载时窗口尚未显示，outerWidth/outerHeight 会读到 0（无头浏览器的典型特征）；
    // 只在读到 0 时用 inner 尺寸加上工具栏高度补上，真实窗口的值原样返回
    const lines = [
        "'use strict';",
        '(function () {',
        '    try {',
        '        const toolbar = 87;',
        '        const patch = (name, fallback, getter) => {',
        '            const original = Object.getOwnPropertyDescriptor(window, name);',
        '            if (!original || !original.get) return;',
        '            const real = original.get;',
        '            Object.defineProperty(window, name, { ...original, get: getter(function () { const value = real.call(this); return value === 0 ? fallback() : value; }) });',
        '        };',
        "        patch('outerWidth', () => window.innerWidth, fn => Object.getOwnPropertyDescriptor({ get outerWidth() { return fn.call(this); } }, 'outerWidth').get);",
        "        patch('outerHeight', () => window.innerHeight + toolbar, fn => Object.getOwnPropertyDescriptor({ get outerHeight() { return fn.call(this); } }, 'outerHeight').get);",
        '    } catch (_) {}'
    ];
    if (profile.navigatorPlatform) {
        lines.push(
            '    try {',
            '        const navProto = Object.getPrototypeOf(navigator);',
            "        Object.defineProperty(navProto, 'platform', {",
            '            configurable: true,',
            `            get: () => ${JSON.stringify(profile.navigatorPlatform)}`,
            '        });',
            '    } catch (_) {}'
        );
    }
    if (profile.disableWebRTC) {
        lines.push(
            '    try {',
            "        const blocked = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDataChannel'];",
            '        for (const name of blocked) {',
            '            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });',
            '        }',
            '        if (navigator.mediaDevices) {',
            "            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {",
            '                configurable: true,',
            '                writable: true,',
            "                value: async () => { throw new DOMException('WebRTC is disabled', 'NotAllowedError'); }",
            '            });',
            '        }',
            '    } catch (_) {}'
        );
    }
    lines.push('})();', '');
    return lines.join('\n');
}

// 容器内 playwright-cli 读取的配置。
// default: 容器内 Xvfb 里的有头浏览器；ws: 附着宿主机 launch-server；cdp: 附着用户自己的 Chrome（不注入指纹）
function buildContainerConfig(kind, options = {}) {
    const base = { outputDir: CONTAINER_OUTPUT_DIR };
    if (kind === 'cdp') {
        return { ...base, browser: { cdpEndpoint: options.endpoint, cdpTimeout: 60000 } };
    }
    const fingerprint = {
        initScript: [CONTAINER_INIT_SCRIPT_PATH],
        contextOptions: buildContextOptions(options)
    };
    if (kind === 'ws') {
        // launch-server 不预创建 context，必须 isolated 才会自建
        return { ...base, browser: { remoteEndpoint: options.endpoint, isolated: true, ...fingerprint } };
    }
    return {
        ...base,
        browser: {
            // 容器内是 root，Chromium 不允许 root 开沙箱
            chromiumSandbox: false,
            browserName: 'chromium',
            ...fingerprint,
            launchOptions: {
                channel: 'chromium',
                headless: false,
                args: buildLaunchArgs(options, 'virtual')
            }
        }
    };
}

// 宿主机 playwright launch-server 的配置
function buildServerConfig({ host, port, wsPath, headless = false, window = 'native', chromiumSandbox = true, extensionArgs = [], ...profileOptions }) {
    return {
        host,
        port,
        wsPath,
        headless,
        channel: 'chromium',
        chromiumSandbox,
        args: [...buildLaunchArgs(profileOptions, window), ...extensionArgs]
    };
}

module.exports = {
    CONTAINER_CONFIG_DIR,
    CONTAINER_CONFIG_PATH,
    CONTAINER_INIT_SCRIPT_PATH,
    DEFAULT_PROFILE,
    resolveProfile,
    detectHostProfile,
    acceptLanguage,
    buildLaunchArgs,
    buildContextOptions,
    buildInitScript,
    buildContainerConfig,
    buildServerConfig
};
