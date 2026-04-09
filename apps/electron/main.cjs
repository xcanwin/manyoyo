'use strict';

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { startElectronWebServer } = require('../../lib/electron/web-runtime');

let mainWindow = null;
let serverHandle = null;
let closing = false;

if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

function buildLoadingHtml(title, message, detail) {
    const safeTitle = String(title || 'MANYOYO');
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
    <div class="eyebrow">MANYOYO Desktop</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${safeDetail ? `<pre>${safeDetail}</pre>` : ''}
  </main>
</body>
</html>`;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 920,
        minWidth: 1120,
        minHeight: 720,
        title: 'MANYOYO',
        backgroundColor: '#f3ede4',
        autoHideMenuBar: true,
        show: false,
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
        if (url && !url.startsWith('http://127.0.0.1:')) {
            shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.webContents.on('will-navigate', function (event, url) {
        if (url && !url.startsWith('http://127.0.0.1:')) {
            event.preventDefault();
            shell.openExternal(url).catch(() => {});
        }
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });

    return mainWindow;
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

async function bootApplication() {
    const win = createWindow();
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('正在启动', '正在准备 MANYOYO 本地桌面服务。'))}`);

    try {
        serverHandle = await startElectronWebServer();
        await installAuthCookie(win.webContents.session, serverHandle.url, serverHandle.authUser, serverHandle.authPass);
        await win.loadURL(`${serverHandle.url}/`);
    } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.error('[manyoyo-electron] startup failed', error);
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('启动失败', 'MANYOYO Desktop 无法完成本地服务初始化。请先检查 Docker/Podman、镜像配置以及 ~/.manyoyo/manyoyo.json。', message))}`);
        dialog.showErrorBox('MANYOYO Desktop 启动失败', message);
    }
}

ipcMain.handle('manyoyo:openExternal', async function (_event, url) {
    const target = String(url || '').trim();
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

app.whenReady().then(bootApplication);
