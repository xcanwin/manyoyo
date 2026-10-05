'use strict';

// 浏览器指纹的唯一数据源：宿主机生成的配置与镜像内的 docker/res/playwright/* 都从这里生成。
// 原则是各项信号自洽：UA、Client Hints、平台、字体、WebGL 一律用浏览器真实值，不做自相矛盾的伪装；
// 只固定语言、时区、窗口形态与自动化痕迹。语言与时区由浏览器进程的原生环境变量（TZ / LANG / LANGUAGE）提供，
// 而不是 Playwright 的 contextOptions 模拟：后者只作用于页面，Worker 里还是系统值，会被检测站点识别为不一致。

const CONTAINER_CONFIG_DIR = '/run/manyoyo-playwright';
const CONTAINER_CONFIG_PATH = `${CONTAINER_CONFIG_DIR}/config.json`;
const CONTAINER_INIT_SCRIPT_PATH = `${CONTAINER_CONFIG_DIR}/stealth.init.js`;
const CONTAINER_OUTPUT_DIR = '/tmp/.playwright-cli';

const DEFAULT_PROFILE = {
    locale: 'en-US',
    timezoneId: 'UTC',
    navigatorPlatform: '',
    disableWebRTC: true
};

function resolveProfile(options = {}) {
    const text = (value, fallback) => String(value || '').trim() || fallback;
    return {
        locale: text(options.locale, DEFAULT_PROFILE.locale),
        timezoneId: text(options.timezoneId, DEFAULT_PROFILE.timezoneId),
        navigatorPlatform: text(options.navigatorPlatform, DEFAULT_PROFILE.navigatorPlatform),
        disableWebRTC: options.disableWebRTC === undefined ? DEFAULT_PROFILE.disableWebRTC : options.disableWebRTC === true
    };
}

// 浏览器进程的原生语言与时区环境变量；值会写进 shell 与 env 文件，所以格式必须严格。
// locale 只取“语言[-文字][-地区]”（兼容 en_US 写法，丢掉 -u- 之类的扩展），LANG 用 ll_RR.UTF-8
function buildProcessEnv(options = {}) {
    const profile = resolveProfile(options);
    const match = /^([A-Za-z]{2,3})(?:[-_][A-Za-z]{4})?(?:[-_]([A-Za-z]{2}|\d{3}))?(?:[-_][A-Za-z0-9]{1,8})*$/.exec(profile.locale);
    if (!match) {
        throw new Error(`locale 格式无效: ${profile.locale}`);
    }
    if (!/^[A-Za-z0-9_+/-]+$/.test(profile.timezoneId)) {
        throw new Error(`timezoneId 格式无效: ${profile.timezoneId}`);
    }
    const language = match[1].toLowerCase();
    const region = match[2] ? match[2].toUpperCase() : '';
    const posix = region ? `${language}_${region}` : language;
    return {
        TZ: profile.timezoneId,
        LANG: `${posix}.UTF-8`,
        LANGUAGE: region ? `${posix}:${language}` : language
    };
}

// 容器内 playwright-cli 包装脚本 source 的文件
function buildContainerEnvFile(options = {}) {
    return Object.entries(buildProcessEnv(options)).map(([key, value]) => `export ${key}='${value}'\n`).join('');
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
function buildContextOptions() {
    return { viewport: null };
}

// 只有 navigatorPlatform（用户显式设置）或 disableWebRTC（默认开启，STUN 会暴露本机公网 IP）生效时才会改写页面；都不需要时什么都不改（每个被改写的 getter 都可能被检测站点当作 lie）
function needsInitScript(profile) {
    return Boolean(profile.navigatorPlatform) || profile.disableWebRTC;
}

function buildInitScript(options = {}) {
    const profile = resolveProfile(options);
    if (!needsInitScript(profile)) {
        return "'use strict';\n";
    }
    const lines = [
        "'use strict';",
        '(function () {'
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
// default: 容器内 Xvfb 里的有头 Google Chrome；ws: 附着宿主机 launch-server；cdp: 附着用户自己的 Chrome（不注入指纹）
function buildContainerConfig(kind, options = {}) {
    const base = { outputDir: CONTAINER_OUTPUT_DIR };
    if (kind === 'cdp') {
        return { ...base, browser: { cdpEndpoint: options.endpoint, cdpTimeout: 60000 } };
    }
    const fingerprint = { contextOptions: buildContextOptions() };
    if (needsInitScript(resolveProfile(options))) {
        fingerprint.initScript = [CONTAINER_INIT_SCRIPT_PATH];
    }
    if (kind === 'ws') {
        // launch-server 不预创建 context，必须 isolated 才会自建
        return { ...base, browser: { remoteEndpoint: options.endpoint, isolated: true, ...fingerprint } };
    }
    return {
        ...base,
        browser: {
            browserName: 'chromium',
            ...fingerprint,
            launchOptions: {
                channel: 'chrome',
                // 容器内是 root，Chrome 不允许 root 开沙箱；必须写在 launchOptions 里才生效
                chromiumSandbox: false,
                headless: false,
                args: buildLaunchArgs(options, 'virtual')
            }
        }
    };
}

// 宿主机 playwright launch-server 的配置
// useChrome 为 false（宿主机没装 Google Chrome）时不写 channel，退回 patchright 自己下载的 Chromium。
// extensionPaths：官方 Google Chrome 从 M137 起忽略 --load-extension，扩展由 playwright-server.js 在启动后经 CDP
// Extensions.loadUnpacked 加载（需要 --enable-unsafe-extension-debugging，所以只在有扩展时才加）；该字段会在 launchServer 前被取走
function buildServerConfig({ host, port, wsPath, headless = false, window = 'native', chromiumSandbox = true, useChrome = true, extensionPaths = [], ...profileOptions }) {
    const config = { host, port, wsPath, headless, chromiumSandbox };
    if (useChrome) {
        config.channel = 'chrome';
    }
    config.args = buildLaunchArgs(profileOptions, window);
    if (extensionPaths.length > 0) {
        config.args.push('--enable-unsafe-extension-debugging');
        config.extensionPaths = extensionPaths;
    }
    return config;
}

module.exports = {
    CONTAINER_CONFIG_DIR,
    CONTAINER_CONFIG_PATH,
    CONTAINER_INIT_SCRIPT_PATH,
    DEFAULT_PROFILE,
    resolveProfile,
    detectHostProfile,
    buildProcessEnv,
    buildContainerEnvFile,
    buildLaunchArgs,
    buildContextOptions,
    buildInitScript,
    buildContainerConfig,
    buildServerConfig
};
