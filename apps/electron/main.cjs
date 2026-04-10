'use strict';

const os = require('os');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const { getManyoyoConfigPath } = require('../../lib/global-config');
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

function getLogsDir() {
    return path.join(os.homedir(), '.manyoyo', 'logs');
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
    dialog.showErrorBox('MANYOYO Desktop', message);
}

function buildApplicationMenu() {
    const template = [
        {
            label: 'MANYOYO',
            submenu: [
                {
                    label: '重新连接工作台',
                    click: function () {
                        restartDesktopServer().catch(showRuntimeError);
                    }
                },
                {
                    label: '在系统浏览器打开当前工作台',
                    click: function () {
                        if (serverHandle && serverHandle.url) {
                            shell.openExternal(`${serverHandle.url}/`).catch(showRuntimeError);
                        }
                    }
                },
                {
                    label: '复制当前工作台地址',
                    click: function () {
                        if (serverHandle && serverHandle.url) {
                            clipboard.writeText(`${serverHandle.url}/`);
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
                { role: 'quit', label: '退出' }
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

async function connectWorkbench(win) {
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
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('正在重连', '正在重启 MANYOYO 本地桌面服务。'))}`);
    await closeServerHandle();
    await connectWorkbench(win);
}

async function bootApplication() {
    buildApplicationMenu();
    const win = createWindow();
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildLoadingHtml('正在启动', '正在准备 MANYOYO 本地桌面服务。'))}`);
    await connectWorkbench(win);
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
