'use strict';
/* istanbul ignore file */
// 不做覆盖率插桩：传给 page.evaluate / addInitScript 的函数按源码序列化后在浏览器里执行，插桩加进去的计数器变量在浏览器里不存在（jest --coverage 下报 cov_xxx is not defined）

// 自动体验检查的驱动：临时 HOME 起 serve → 建容器并换上假 claude → 真实浏览器发送提示词 →
// 按“用户动作”操作页面，用探针逐帧采样并判定。CLI 脚本与 jest 集成测试共用。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeSource, evaluate } = require('./probe');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// patchright 的 evaluate 默认跑在隔离世界里，读不到探针挂在页面上的 window.__ux：第三个参数 false 指定主世界
const ev = (page, fn, arg) => page.evaluate(fn, arg, undefined, false);

function findChrome() {
    const candidates = [process.env.UX_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    return candidates.find(p => p && fs.existsSync(p)) || '';
}

async function startServe({ runtime, port, home }) {
    fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
    const env = { ...process.env, HOME: home };
    // rootless podman 的存储在真实用户目录下：换了 HOME 也要指回去，否则看不到本机镜像
    const realHome = os.homedir();
    if (runtime.command === 'podman') {
        env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(realHome, '.local', 'share');
        env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(realHome, '.config');
        if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    }
    ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].forEach(key => { delete env[key]; });
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'manyoyo.js'), 'serve', `127.0.0.1:${port}`, '-U', 'u', '-P', 'p'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
        try {
            const res = await fetch(`${base}/auth/login`);
            if (res.status) return { child, base, log: () => log };
        } catch (e) {
            // 还没起来
        }
        if (child.exitCode !== null) break;
        await sleep(250);
    }
    child.kill('SIGTERM');
    throw new Error(`serve 没有启动：\n${log.slice(-2000)}`);
}

function createApi(base) {
    let cookie = '';
    async function call(method, urlPath, body) {
        const res = await fetch(base + urlPath, {
            method,
            headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        if (urlPath === '/auth/login') cookie = (res.headers.get('set-cookie') || '').split(';')[0];
        return { status: res.status, json, text };
    }
    return {
        call,
        login: () => call('POST', '/auth/login', { username: 'u', password: 'p' })
    };
}

// 建会话并把容器里的 claude 换成假脚本（/usr/local/sbin 在 PATH 里排在 /usr/local/bin 之前）
async function createFakeSession({ api, runtime, name, work, imageVersion }) {
    const res = await api.call('POST', '/api/sessions', {
        createOptions: { containerName: name, hostPath: work, containerPath: work, agentPromptCommand: 'claude -p {prompt}', imageVersion }
    });
    if (res.status >= 300) throw new Error(`建会话失败 ${res.status} ${res.text.slice(0, 300)}`);
    const rt = args => spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env } });
    let r = rt(['cp', FAKE_CLAUDE, `${name}:/tmp/fake-claude.js`]);
    if (r.status !== 0) throw new Error(r.stderr);
    r = rt(['exec', '-u', 'root', name, 'sh', '-c', 'cp /tmp/fake-claude.js /usr/local/sbin/claude && chmod 755 /usr/local/sbin/claude']);
    if (r.status !== 0) throw new Error(r.stderr);
    return {
        expected(token) {
            const out = rt(['exec', name, 'cat', `/tmp/ux-expected-${token.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`]);
            return out.status === 0 ? out.stdout : null;
        }
    };
}

async function openChat(browser, { base, name, mobile = false, dark = false }) {
    const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: dark ? 'dark' : 'light'
    });
    await context.addInitScript(probeSource);
    const page = await context.newPage();
    await page.goto(`${base}/auth/login`);
    const inputs = page.locator('input');
    await inputs.nth(0).fill('u');
    await inputs.nth(1).fill('p');
    await page.keyboard.press('Enter');
    await page.waitForURL(u => !u.pathname.startsWith('/auth/login'), { timeout: 20000 });
    await page.goto(`${base}/?r=${Date.now()}#${encodeURIComponent(`${name}~agent-1`)}`);
    await skipWizard(page);
    return page;
}

// 全新 HOME 没配过 Agent 时每次打开页面都会弹配置向导
async function skipWizard(page) {
    await page.waitForTimeout(1500);
    const skip = page.getByText('跳过向导');
    if (await skip.count()) {
        await skip.first().click();
        await page.waitForTimeout(500);
    }
    await page.waitForSelector('textarea', { timeout: 20000 });
}

async function isRunning(page) {
    return (await page.locator('button:has-text("停止")').count()) > 0;
}

async function waitIdle(page, timeoutMs = 180000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (!(await isRunning(page))) return;
        await sleep(250);
    }
    throw new Error('任务一直没有结束');
}

async function send(page, text) {
    await page.locator('textarea').first().fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForSelector('button:has-text("停止")', { timeout: 20000 });
}

// 在消息流里滚动：桌面用滚轮，手机用真实的触摸拖动（CDP dispatchTouchEvent；headless 下
// synthesizeScrollGesture 的 touch 手势不会滚动，实测无效）。dy < 0 是往上看历史（手指往下拖）
async function scrollChat(page, dy, mobile) {
    const box = await page.locator('[data-chat-scroll]').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (mobile) {
        const cdp = await page.context().newCDPSession(page);
        const steps = 10;
        const y0 = y - dy / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
        for (let i = 1; i <= steps; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - (dy * i) / steps }] });
            await sleep(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
    } else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, dy);
    }
}

async function probeNow(page) {
    return ev(page, () => performance.now());
}

async function lastTraceButton(page, label) {
    return page.locator('[data-trace-block]').last().locator(`button[aria-label="${label}"]`);
}

async function expandLastTrace(page) {
    const block = page.locator('[data-trace-block]').last();
    await block.waitFor({ timeout: 20000 });
    if ((await block.getAttribute('data-open')) !== 'true') {
        await block.locator('button').first().click();
    }
    await page.waitForTimeout(200);
}

// 一个用例：发送 → 按 action 操作 → 采样到任务结束 → 判定
// action：bottom（一直不动）/ pin-bottom（展开后点“对齐到底部”）/ pin-top / click（贴底时点一下空白处）/ read（上滑阅读）
async function runCase(page, { prompt, action, mobile = false, warmMs = 1500 }) {
    await ev(page, () => window.__ux.start());
    await send(page, prompt);
    let fromT = (await probeNow(page)) + 400;
    let mode = 'bottom';
    if (action !== 'bottom') await page.waitForTimeout(warmMs);
    if (action === 'reload' || action === 'reload-pin') {
        // 运行中刷新页面：走恢复轮询（列表里的 trace 是截断版、回复由服务端的 streamingReply 顶替）
        await page.reload();
        await skipWizard(page);
        await page.waitForSelector('button:has-text("停止")', { timeout: 20000 });
        await page.waitForTimeout(800);
        await ev(page, () => window.__ux.start());
        fromT = await probeNow(page);
    }
    if (action === 'pin-bottom' || action === 'pin-top' || action === 'reload-pin') {
        await expandLastTrace(page);
        const label = action === 'pin-top' ? '执行过程对齐到顶部' : '执行过程对齐到底部';
        await (await lastTraceButton(page, label)).click();
        await ev(page, () => window.__ux.pinLast());
        await page.waitForTimeout(400);
        fromT = await probeNow(page);
        mode = action === 'pin-top' ? 'pin-top' : 'pin-bottom';
    } else if (action === 'click') {
        const box = await page.locator('[data-chat-scroll]').boundingBox();
        await page.mouse.click(box.x + 3, box.y + box.height / 2);
        fromT = await probeNow(page);
    } else if (action === 'read') {
        await scrollChat(page, -350, mobile);
        await page.waitForTimeout(900);
        // 测试手段先自证：滚动没生效时视野仍贴底，后面的“偏离”只是正常跟随，结论是假的（headless 下触摸手势曾经不滚）
        const gap = await ev(page, () => { const b = document.querySelector('[data-chat-scroll]'); return b.scrollHeight - b.scrollTop - b.clientHeight; });
        if (gap <= 2) throw new Error('上滑没有生效：视野仍贴着底部');
        await ev(page, () => window.__ux.pickRef());
        fromT = await probeNow(page);
        mode = 'still';
    }
    await waitIdle(page);
    await page.waitForTimeout(1500);
    const data = await ev(page, () => {
        window.__ux.stop();
        const ux = window.__ux;
        return { frames: ux.frames, inputs: ux.inputs, traceRemovals: ux.traceRemovals, autoCollapse: ux.autoCollapse, cls: ux.cls, loadingSeen: ux.loadingSeen };
    });
    const result = evaluate(data, { mode, fromT });
    return { ...result, data };
}

// 界面上最后一条 AGENT 回复（不含执行过程）的纯文本
async function lastReplyText(page) {
    return ev(page, () => {
        const box = document.querySelector('[data-chat-scroll]');
        let replies = [...box.querySelectorAll('[data-reply]')];
        // 旧版界面没有 data-reply：退回按回复气泡的样式找
        if (!replies.length) replies = [...box.querySelectorAll('.rounded-xl.border.w-full')];
        const last = replies[replies.length - 1];
        return last ? last.innerText : '';
    });
}

module.exports = { ROOT, findChrome, startServe, createApi, createFakeSession, openChat, runCase, waitIdle, send, scrollChat, lastReplyText, expandLastTrace, sleep };
