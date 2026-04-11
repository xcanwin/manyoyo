'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const { getManyoyoConfigPath } = require('../../../lib/global-config');
const { startElectronWebServer } = require('../../../lib/electron/web-runtime');
const { createAutoUpdateController } = require('../../../lib/electron/auto-update');

const APP_NAME = 'MANYOYO Desktop';
const APP_SHORT_NAME = 'MANYOYO';
const APP_ID = 'io.github.xcanwin.manyoyo.desktop';
const ICON_PATH = path.join(__dirname, 'assets', 'icon-512.png');
const AUTO_SERVE_ENV_NAME = 'MANYOYO_DESKTOP_AUTO_SERVE';
const SERVER_URL_ENV_NAME = 'MANYOYO_SERVER_URL';
const CLIENT_STATE_FILE = 'desktop-client.json';

let mainWindow = null;
let serverHandle = null;
let closing = false;
let desktopUpdater = null;
let updateDialogLock = false;
let activeWorkbenchUrl = '';

if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

function buildLoadingHtml(title, message, detail) {
    const safeTitle = String(title || APP_NAME);
    const safeMessage = String(message || '');
    const safeDetail = String(detail || '');
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(160deg, #efe3d0 0%, #f7f1e8 100%);
      color: #1f1a14;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(760px, 100%);
      background: rgba(255,255,255,0.92);
      border: 1px solid rgba(165, 126, 72, 0.25);
      border-radius: 20px;
      box-shadow: 0 18px 60px rgba(66, 42, 12, 0.14);
      padding: 28px 28px 22px;
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #97511d;
      margin-bottom: 10px;
      font-weight: 700;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      color: #5e5244;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    pre {
      margin: 18px 0 0;
      padding: 16px;
      border-radius: 14px;
      background: #1a1f29;
      color: #f2f5fb;
      overflow: auto;
      font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="eyebrow">${APP_NAME}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${safeDetail ? `<pre>${safeDetail}</pre>` : ''}
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildClientLauncherHtml(initialUrl, statusMessage) {
    const safeInitialUrl = JSON.stringify(String(initialUrl || ''));
    const safeStatusMessage = statusMessage ? `<p class="status">${escapeHtml(statusMessage)}</p>` : '';
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${APP_NAME}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(160deg, #efe3d0 0%, #f7f1e8 100%);
      color: #1f1a14;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(840px, 100%);
      background: rgba(255,255,255,0.94);
      border: 1px solid rgba(165, 126, 72, 0.22);
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(66, 42, 12, 0.14);
      padding: 28px;
    }
    .eyebrow {
      display: inline-flex;
      padding: 6px 10px;
      border-radius: 999px;
      background: #f0dfc8;
      color: #97511d;
      font-size: 12px;
      letter-spacing: 0.16em;
      font-weight: 700;
      text-transform: uppercase;
    }
    h1 {
      margin: 16px 0 12px;
      font-size: 30px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: #5e5244;
    }
    .status {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 14px;
      background: #f3f8f5;
      color: #284238;
      border: 1px solid rgba(11, 110, 79, 0.18);
    }
    .panel {
      margin-top: 24px;
      padding: 18px;
      border-radius: 18px;
      background: #f7f3ec;
      border: 1px solid rgba(11, 110, 79, 0.12);
    }
    label {
      display: block;
      margin-bottom: 10px;
      font-size: 14px;
      font-weight: 700;
      color: #284238;
    }
    input {
      width: 100%;
      padding: 13px 14px;
      border-radius: 12px;
      border: 1px solid #d6c4ad;
      font-size: 15px;
      outline: none;
    }
    input:focus {
      border-color: #0b6e4f;
      box-shadow: 0 0 0 4px rgba(11, 110, 79, 0.12);
    }
    .actions {
      margin-top: 14px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.12s ease, opacity 0.12s ease;
    }
    button:hover { transform: translateY(-1px); }
    button.primary {
      background: #0b6e4f;
      color: #fff;
    }
    button.secondary {
      background: #e8f1ec;
      color: #173429;
    }
    button.ghost {
      background: #f0dfc8;
      color: #7a4d21;
    }
    small {
      display: block;
      margin-top: 14px;
      color: #6e6355;
      line-height: 1.7;
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">${APP_SHORT_NAME}</div>
    <h1>默认只启动客户端</h1>
    <p>当前 Electron 桌面端默认不再自动拉起本地 manyoyo 服务。你可以直接填写已有 MANYOYO 地址，也可以在启动前设置 <code>${AUTO_SERVE_ENV_NAME}=1</code> 恢复“服务 + 客户端”联动模式。</p>
    ${safeStatusMessage}
    <section class="panel">
      <label for="serverUrl">MANYOYO 地址</label>
      <input id="serverUrl" type="url" placeholder="http://127.0.0.1:3000" />
      <div class="actions">
        <button class="secondary" id="fillLocal">填入本机地址</button>
        <button class="ghost" id="saveUrl">保存地址</button>
        <button class="primary" id="openInternal">进入内置 MANYOYO</button>
        <button class="secondary" id="openExternal">在系统浏览器打开</button>
      </div>
      <small>也可以通过环境变量 <code>${SERVER_URL_ENV_NAME}</code> 预填默认地址；已保存地址会作为下次启动默认值。</small>
    </section>
  </main>
  <script>
    const input = document.getElementById('serverUrl');
    const initialUrl = ${safeInitialUrl};
    if (initialUrl) {
      input.value = initialUrl;
    }

    function currentUrl() {
      return String(input.value || '').trim();
    }

    async function saveUrl() {
      await window.ManyoyoNativeBridge.saveWorkbenchUrl(currentUrl());
    }

    document.getElementById('fillLocal').addEventListener('click', function () {
      input.value = 'http://127.0.0.1:3000';
      input.focus();
      input.select();
    });

    document.getElementById('saveUrl').addEventListener('click', function () {
      saveUrl().catch(function (error) {
        alert(error && error.message ? error.message : String(error));
      });
    });

    document.getElementById('openInternal').addEventListener('click', function () {
      window.ManyoyoNativeBridge.openWorkbench(currentUrl()).catch(function (error) {
        alert(error && error.message ? error.message : String(error));
      });
    });

    document.getElementById('openExternal').addEventListener('click', async function () {
      try {
        await saveUrl();
        await window.ManyoyoNativeBridge.openExternal(currentUrl());
      } catch (error) {
        alert(error && error.message ? error.message : String(error));
      }
    });
  </script>
</body>
</html>`;
}

function isTruthyEnvValue(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isDesktopAutoServeEnabled() {
    return isTruthyEnvValue(process.env[AUTO_SERVE_ENV_NAME]);
}

function normalizeWorkbenchUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error('MANYOYO 地址无效，请填写 http(s)://host[:port]。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('MANYOYO 地址仅支持 http 或 https。');
    }
    return parsed.toString();
}

function getClientStatePath() {
    return path.join(app.getPath('userData'), CLIENT_STATE_FILE);
}

function readSavedWorkbenchUrl() {
    try {
        const statePath = getClientStatePath();
        if (!fs.existsSync(statePath)) {
            return '';
        }
        const text = fs.readFileSync(statePath, 'utf-8');
        const payload = JSON.parse(text);
        return normalizeWorkbenchUrl(payload && payload.serverUrl);
    } catch (error) {
        return '';
    }
}

function saveWorkbenchUrl(url) {
    const normalized = normalizeWorkbenchUrl(url);
    const statePath = getClientStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`, 'utf-8');
    return normalized;
}

function clearSavedWorkbenchUrl() {
    const statePath = getClientStatePath();
    if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
    }
}

function resolveInitialWorkbenchUrl() {
    const envUrl = String(process.env[SERVER_URL_ENV_NAME] || '').trim();
    if (envUrl) {
        return normalizeWorkbenchUrl(envUrl);
    }
    return readSavedWorkbenchUrl();
}

function setActiveWorkbenchUrl(url) {
    activeWorkbenchUrl = String(url || '').trim();
}

function getCurrentWorkbenchUrl() {
    if (serverHandle && serverHandle.url) {
        return `${serverHandle.url}/`;
    }
    return activeWorkbenchUrl;
}

function isAllowedWorkbenchUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
        return false;
    }
    if (value.startsWith('data:text/html')) {
        return true;
    }
    let target;
    try {
        target = new URL(value);
    } catch (error) {
        return false;
    }
    const allowedOrigins = [];
    const currentUrl = getCurrentWorkbenchUrl();
    if (currentUrl) {
        try {
            allowedOrigins.push(new URL(currentUrl).origin);
        } catch (error) {
            // ignore invalid URL state
        }
    }
    return allowedOrigins.includes(target.origin);
}

function getApplicationIconPath() {
    return fs.existsSync(ICON_PATH) ? ICON_PATH : '';
}

function getLogsDir() {
    return path.join(os.homedir(), '.manyoyo', 'logs');
}

function getDesktopUpdateStatus() {
    return desktopUpdater ? desktopUpdater.getStatus() : {
        enabled: false,
        canCheck: false,
        canDownload: false,
        canInstall: false,
        label: '自动更新未初始化',
        detail: '应用尚未完成初始化。'
    };
}

async function loadClientLauncher(win, options = {}) {
    setActiveWorkbenchUrl('');
    let initialUrl = options.initialUrl;
    let statusMessage = options.statusMessage || '';
    if (initialUrl === undefined) {
        try {
            initialUrl = resolveInitialWorkbenchUrl();
        } catch (error) {
            initialUrl = '';
            statusMessage = statusMessage || (error && error.message ? error.message : String(error));
        }
    }
    const html = buildClientLauncherHtml(initialUrl, statusMessage);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function loadWorkbenchUrl(win, rawUrl) {
    const url = normalizeWorkbenchUrl(rawUrl);
    setActiveWorkbenchUrl(url);
    await win.loadURL(url);
    return { url };
}

async function openPathInSystem(targetPath) {
    const text = String(targetPath || '').trim();
    if (!text) {
        return;
    }
    const result = await shell.openPath(text);
    if (result) {
        throw new Error(result);
    }
}

async function revealConfigFile() {
    const configPath = getManyoyoConfigPath();
    try {
        shell.showItemInFolder(configPath);
    } catch (error) {
        await openPathInSystem(path.dirname(configPath));
    }
}

function showRuntimeError(error) {
    const message = error && error.message ? error.message : String(error);
    dialog.showErrorBox(APP_NAME, message);
}

async function showUpdateDialog(title, message, detail) {
    if (updateDialogLock) {
        return;
    }
    updateDialogLock = true;
    try {
        await dialog.showMessageBox({
            type: 'info',
            title,
            message,
            detail: detail || '',
            buttons: ['知道了']
        });
    } finally {
        updateDialogLock = false;
    }
}

async function checkForUpdatesFromMenu() {
    const status = getDesktopUpdateStatus();
    if (!status.canCheck) {
        throw new Error(status.detail || status.label);
    }
    await desktopUpdater.checkForUpdates();
    const nextStatus = getDesktopUpdateStatus();
    await showUpdateDialog('MANYOYO Desktop 更新检查', nextStatus.label, nextStatus.detail);
}

async function downloadUpdateFromMenu() {
    const status = getDesktopUpdateStatus();
    if (!status.canDownload) {
        throw new Error(status.detail || '当前没有可下载的更新。');
    }
    await desktopUpdater.downloadUpdate();
    const nextStatus = getDesktopUpdateStatus();
    await showUpdateDialog('MANYOYO Desktop 更新下载', nextStatus.label, nextStatus.detail);
}

function installDownloadedUpdate() {
    const status = getDesktopUpdateStatus();
    if (!status.canInstall) {
        throw new Error(status.detail || '当前没有已下载完成的更新。');
    }
    desktopUpdater.quitAndInstall();
}

function buildApplicationMenu() {
    const updateStatus = getDesktopUpdateStatus();
    const autoServeEnabled = isDesktopAutoServeEnabled();
    const reconnectLabel = autoServeEnabled ? '重启本地工作台' : '切换 MANYOYO 地址';
    const template = [
        {
            label: APP_SHORT_NAME,
            submenu: [
                { label: `版本 ${app.getVersion()}`, enabled: false },
                { label: updateStatus.label, enabled: false },
                {
                    label: '检查更新',
                    enabled: Boolean(updateStatus.canCheck),
                    click: function () {
                        checkForUpdatesFromMenu().catch(showRuntimeError);
                    }
                },
                {
                    label: '下载更新',
                    enabled: Boolean(updateStatus.canDownload),
                    click: function () {
                        downloadUpdateFromMenu().catch(showRuntimeError);
                    }
                },
                {
                    label: '安装已下载更新',
                    enabled: Boolean(updateStatus.canInstall),
                    click: function () {
                        try {
                            installDownloadedUpdate();
                        } catch (error) {
                            showRuntimeError(error);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: reconnectLabel,
                    click: function () {
                        if (autoServeEnabled) {
                            restartDesktopServer().catch(showRuntimeError);
                            return;
                        }
                        if (mainWindow) {
                            loadClientLauncher(mainWindow).catch(showRuntimeError);
                        }
                    }
                },
                {
                    label: '在系统浏览器打开当前工作台',
                    click: function () {
                        const currentUrl = getCurrentWorkbenchUrl();
                        if (currentUrl) {
                            shell.openExternal(currentUrl).catch(showRuntimeError);
                        }
                    }
                },
                {
                    label: '复制当前工作台地址',
                    click: function () {
                        const currentUrl = getCurrentWorkbenchUrl();
                        if (currentUrl) {
                            clipboard.writeText(currentUrl);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: '打开 manyoyo 配置目录',
                    click: function () {
                        openPathInSystem(path.dirname(getManyoyoConfigPath())).catch(showRuntimeError);
                    }
                },
                {
                    label: '定位 manyoyo 配置文件',
                    click: function () {
                        revealConfigFile().catch(showRuntimeError);
                    }
                },
                {
                    label: '打开日志目录',
                    click: function () {
                        openPathInSystem(getLogsDir()).catch(showRuntimeError);
                    }
                },
                { type: 'separator' },
                { role: 'about', label: `关于 ${APP_NAME}` },
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'reload', label: '刷新' },
                { role: 'forceReload', label: '强制刷新' },
                { role: 'togglefullscreen', label: '切换全屏' },
                { role: 'minimize', label: '最小化' },
                { role: 'toggleDevTools', label: '开发者工具' }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    const iconPath = getApplicationIconPath();
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 920,
        minWidth: 1120,
        minHeight: 720,
        title: APP_NAME,
        backgroundColor: '#f3ede4',
        autoHideMenuBar: true,
        show: false,
        icon: iconPath || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.once('ready-to-show', function () {
        if (mainWindow) {
            mainWindow.show();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url && !isAllowedWorkbenchUrl(url)) {
            shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.webContents.on('will-navigate', function (event, url) {
        if (url && !isAllowedWorkbenchUrl(url)) {
            event.preventDefault();
            shell.openExternal(url).catch(() => {});
        }
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });

    return mainWindow;
}

async function connectWorkbench(win) {
    try {
        serverHandle = await startElectronWebServer();
        await installAuthCookie(win.webContents.session, serverHandle.url, serverHandle.authUser, serverHandle.authPass);
        await loadWorkbenchUrl(win, `${serverHandle.url}/`);
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.error('[manyoyo-electron] startup failed', error);
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('启动失败', `${APP_NAME} 无法完成本地服务初始化。请先检查 Docker/Podman、镜像配置以及 ~/.manyoyo/manyoyo.json。`, message))}`);
        dialog.showErrorBox(`${APP_NAME} 启动失败`, message);
    }
}

async function installAuthCookie(targetSession, baseUrl, authUser, authPass) {
    const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: authUser,
            password: authPass
        })
    });

    if (!response.ok) {
        const payload = await response.text().catch(() => '');
        throw new Error(`自动登录失败: ${payload || response.status}`);
    }

    const cookieHeaders = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const authCookie = cookieHeaders.find(header => String(header || '').startsWith('manyoyo_web_auth='));
    if (!authCookie) {
        throw new Error('未获取到登录 Cookie');
    }

    const matched = String(authCookie).match(/^([^=]+)=([^;]+)/);
    if (!matched) {
        throw new Error('登录 Cookie 解析失败');
    }

    await targetSession.cookies.set({
        url: baseUrl,
        name: matched[1],
        value: decodeURIComponent(matched[2]),
        path: '/',
        httpOnly: true,
        sameSite: 'strict'
    });
}

async function closeServerHandle() {
    if (!serverHandle) {
        return;
    }
    const currentHandle = serverHandle;
    serverHandle = null;
    try {
        await currentHandle.close();
    } catch (error) {
        console.error('[manyoyo-electron] close server failed', error);
    }
}

async function restartDesktopServer() {
    const win = mainWindow;
    if (!win) {
        return;
    }
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('正在重连', `正在重启 ${APP_NAME} 本地桌面服务。`))}`);
    await closeServerHandle();
    await connectWorkbench(win);
}

async function bootApplication() {
    buildApplicationMenu();
    const win = createWindow();
    if (isDesktopAutoServeEnabled()) {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('正在启动', `正在准备 ${APP_NAME} 本地桌面服务。`))}`);
        await connectWorkbench(win);
        return;
    }
    let initialUrl = '';
    try {
        initialUrl = resolveInitialWorkbenchUrl();
    } catch (error) {
        await loadClientLauncher(win, { statusMessage: error && error.message ? error.message : String(error) });
        return;
    }
    if (initialUrl) {
        try {
            await loadWorkbenchUrl(win, initialUrl);
            return;
        } catch (error) {
            await loadClientLauncher(win, { statusMessage: error && error.message ? error.message : String(error) });
            return;
        }
    }
    await loadClientLauncher(win);
}

ipcMain.handle('manyoyo:openWorkbench', async function (_event, url) {
    if (!mainWindow) {
        throw new Error('桌面窗口尚未就绪。');
    }
    const normalized = saveWorkbenchUrl(url);
    await loadWorkbenchUrl(mainWindow, normalized);
    return { url: normalized };
});

ipcMain.handle('manyoyo:saveWorkbenchUrl', async function (_event, url) {
    const value = String(url || '').trim();
    if (!value) {
        clearSavedWorkbenchUrl();
        return { url: '' };
    }
    const normalized = saveWorkbenchUrl(value);
    return { url: normalized };
});

ipcMain.handle('manyoyo:openExternal', async function (_event, url) {
    const target = normalizeWorkbenchUrl(url);
    if (!target) {
        return false;
    }
    await shell.openExternal(target);
    return true;
});

app.on('window-all-closed', function () {
    app.quit();
});

app.on('before-quit', function (event) {
    if (closing) {
        return;
    }
    closing = true;
    event.preventDefault();
    closeServerHandle().finally(function () {
        app.quit();
    });
});

app.whenReady().then(function () {
    app.setName(APP_NAME);
    app.setAppUserModelId(APP_ID);
    app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        website: 'https://github.com/xcanwin/manyoyo'
    });
    if (process.platform === 'darwin' && app.dock && getApplicationIconPath()) {
        app.dock.setIcon(getApplicationIconPath());
    }
    desktopUpdater = createAutoUpdateController();
    desktopUpdater.onDidChange(function () {
        buildApplicationMenu();
    });
    return bootApplication();
});
