'use strict';

// 自动体验检查：真实浏览器 + 真实容器里的假 claude（与真实 Claude Code 同形的事件流），
// 逐帧判定执行中视野有没有回跳、点了“对齐到底部”后是否一直贴着、上滑阅读时有没有被拉走、
// 执行过程有没有被重新挂载，以及结束后回复框里是不是真正的最终回复。
// 运行：npm run test:experience（随 npm run test:integration 一起跑）。没有容器运行时、镜像或 Chrome 时跳过。
// 失败时探针时间线写到 $TMPDIR/ux-experience-*.json。改执行过程或消息流滚动逻辑必须跑它。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { sidecarName } = require('../../lib/egress-sidecar');
const h = require('./helpers/chat-experience/harness');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
let runtime = null;
let skipReason = '';
let chromium = null;
try {
    runtime = selectContainerRuntime();
    const rtEnv = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env: rtEnv }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', `${IMAGE_NAME}:${imageVersion}`], { stdio: 'ignore', env: rtEnv }).status !== 0) skipReason = `本机没有镜像 ${IMAGE_NAME}:${imageVersion}`;
    else if (!h.findChrome()) skipReason = '找不到 Chrome（可用 UX_CHROME 指定）';
    else if (!fs.existsSync(path.join(h.ROOT, 'lib', 'web', 'index.html'))) skipReason = '没有前端产物，先 npm run build:web';
    else ({ chromium } = require('patchright-core'));
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[web-chat-experience 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

// 场景:动作[:参数]。场景见 fake-claude.js，动作见 harness.runCase
const DESKTOP = [
    'multi:bottom', 'multi:pin-bottom', 'multi:pin-top', 'multi:click', 'multi:read', 'multi:reload', 'multi:reload-pin',
    'parallel:pin-bottom', 'background:bottom', 'long:bottom', `big:bottom:${process.env.UX_BIG_MB || 34}`
];
const MOBILE = ['multi:bottom', 'multi:read', 'multi:pin-bottom', 'multi:click'];

function firstLine(text) {
    return text.split('\n')[0].trim();
}
function lastLine(text) {
    return text.trim().split('\n').pop().replace(/^- /, '').trim();
}

maybe('自动体验检查（真实浏览器 + 假 claude）', () => {
    jest.setTimeout(30 * 60 * 1000);
    let home;
    let work;
    let serve;
    let api;
    let browser;
    let fake;
    const name = `ux-exp-${process.pid}`;
    const rt = args => spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env } });

    beforeAll(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-exp-home-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-exp-work-'));
        serve = await h.startServe({ runtime, port: 39000 + (process.pid % 900), home });
        api = h.createApi(serve.base);
        await api.login();
        fake = await h.createFakeSession({ api, runtime, name, work, imageVersion });
        browser = await chromium.launch({ executablePath: h.findChrome(), headless: true, args: ['--no-sandbox'] });
    });

    afterAll(async () => {
        if (browser) await browser.close();
        if (serve) serve.child.kill('SIGTERM');
        rt(['rm', '-f', name]);
        // 过滤代理 sidecar 按 HOME 区分：只删这个临时 HOME 起的那个（有的话）
        rt(['rm', '-f', sidecarName(home)]);
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });

    async function check(list, mobile) {
        const page = await h.openChat(browser, { base: serve.base, name, mobile });
        const failures = [];
        try {
            // 预热：先跑一轮把消息流撑到能滚动。全新会话内容不满一屏时不会滚动，抖动测不出来（旧代码实测）
            await h.runCase(page, { prompt: `UXS:multi:6_${Date.now() % 1000000} 预热`, action: 'bottom', mobile });
            for (const item of list) {
                const [scenario, action, param = ''] = item.split(':');
                const token = `UXS:${scenario}:${param || 'x'}_${Date.now() % 1000000}`;
                const label = `${mobile ? '手机' : '桌面'} ${item}`;
                const result = await h.runCase(page, { prompt: `${token} 体验检查`, action, mobile });
                const expected = fake.expected(token);
                const messages = (await api.call('GET', `/api/sessions/${name}/messages?limit=10`)).json.messages;
                const reply = messages.filter(m => m.role === 'assistant' && !m.streamTrace).pop();
                const shown = await h.lastReplyText(page);
                const problems = [...result.problems];
                if (expected === null) problems.push('假 claude 没写出期望的最终回复');
                else {
                    if (!reply || reply.content !== expected) problems.push(`保存的最终回复不对：${JSON.stringify(String(reply && reply.content).slice(0, 60))}`);
                    if (!shown.includes(firstLine(expected)) || !shown.includes(lastLine(expected))) problems.push(`界面上的最终回复不对：${JSON.stringify(shown.slice(0, 60))}`);
                }
                // UX_REPORT=<文件>：每个用例的指标追加一行 JSON（前后对比用）
                if (process.env.UX_REPORT) fs.appendFileSync(process.env.UX_REPORT, JSON.stringify({ label, ok: !problems.length, problems, stats: result.stats }) + '\n');
                if (problems.length) {
                    const file = path.join(os.tmpdir(), `ux-experience-${label.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
                    fs.writeFileSync(file, JSON.stringify(result.data));
                    failures.push(`${label}: ${problems.join('; ')}（时间线 ${file}）`);
                }
            }
        } finally {
            await page.context().close();
        }
        return failures;
    }

    test('桌面：执行中不回跳、对齐按钮可靠、阅读不被拉走、最终回复正确', async () => {
        expect(await check(DESKTOP, false)).toEqual([]);
    });

    test('手机 390px：同上（触摸滚动）', async () => {
        expect(await check(MOBILE, true)).toEqual([]);
    });
});
