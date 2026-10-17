const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer, __testing } = require('../lib/web/server');

const { extractAgentMessageFromStructuredOutput } = __testing;

// 最终回复的取值：输出超过原始缓冲上限（默认 32MB）后不能退回截断点之前的中间说明；不再按 16000 字截断；
// Claude 的 result 事件是权威的最终文本（后台任务场景结尾有两个 result，第一个是中间结论）。
// 样本：test/fixtures/claude-background-task.ndjson（claude 2.1.290 真实输出，已精简脱敏）

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

async function request(url, options = {}) {
    const merged = Object.assign({}, options);
    if ((options.method || 'GET').toUpperCase() !== 'GET') {
        merged.headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {});
    }
    const response = await fetch(url, merged);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { response, text, json };
}

async function readNdjson(url, options) {
    const response = await fetch(url, Object.assign({}, options, {
        headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {})
    }));
    const body = await response.text();
    return body.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

// 假 docker：agent 的 exec 原样输出 stdout.ndjson
function writeFakeDocker(tempHost, ndjson) {
    const data = path.join(tempHost, 'stdout.ndjson');
    fs.writeFileSync(data, ndjson);
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('/bin/bash')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(data)}));
  return;
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

function line(obj) {
    return `${JSON.stringify(obj)}\n`;
}

function assistantText(text) {
    return line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
}

// 中间说明 → 大段工具结果（把输出撑过上限）→ 最终回复 → result
function bigOutputStream(finalText, padChars) {
    return [
        line({ type: 'system', subtype: 'init', session_id: 'sess-big' }),
        assistantText('先读几个大文件。'),
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(padChars) }] } }),
        assistantText('大文件都读完了，开始写结论。'),
        assistantText(finalText),
        line({ type: 'result', subtype: 'success', result: finalText, session_id: 'sess-big', usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.5 })
    ].join('');
}

async function withServer(ndjson, serverOverrides, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-final-reply-'));
    const dir = path.join(tempHost, 'web-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({
        containerName: 'demo', updatedAt: null, messages: [], agentPromptCommand: 'claude -p {prompt}'
    }));
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1',
            serverPort: port,
            authUser: 'webadmin',
            authPass: 'topsecret',
            authPassAuto: false,
            dockerCmd: writeFakeDocker(tempHost, ndjson),
            networkManager: {
                ensureBridgeNetwork: async () => {},
                resolveRefs: async policy => policy,
                apply: async () => ({ status: 'applied' }),
                ensureReady: async () => ({ status: 'applied' })
            },
            hostPath: tempHost,
            homeDir: tempHost,
            containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.0.0-common',
            execCommandPrefix: '',
            execCommand: '',
            execCommandSuffix: '',
            contModeArgs: [],
            containerEnvs: [],
            containerVolumes: [],
            validateHostPath: () => {},
            formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: () => true,
            getContainerStatus: () => 'running',
            waitForContainerReady: async () => {},
            dockerExecArgs: () => '',
            showImagePullHint: () => {},
            removeContainer: () => {},
            webHistoryDir: dir,
            webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
            ...serverOverrides
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        const cookie = login.response.headers.get('set-cookie').split(';')[0];
        await fn({ baseUrl, cookie, tempHost });
    } finally {
        if (handle && typeof handle.close === 'function') await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

function lastReply(tempHost) {
    const history = JSON.parse(fs.readFileSync(path.join(tempHost, 'web-history', 'demo.json'), 'utf-8'));
    const messages = Object.values(history.agents || {}).flatMap(agent => agent.messages || []);
    return messages.filter(m => m.role === 'assistant' && !m.streamTrace).pop();
}

describe('最终回复取值', () => {
    test('流式：输出超过原始缓冲上限后，最终回复仍是真正的最终文本，用量也不丢', async () => {
        const finalText = '大输出场景：全部完成。';
        await withServer(bigOutputStream(finalText, 5000), { agentRawOutputMaxChars: 2000 }, async ({ baseUrl, cookie, tempHost }) => {
            const events = await readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'go', clientMessageId: 'final-reply-0001' })
            });
            const result = events.find(event => event.type === 'result');
            expect(result.output).toBe(finalText);
            const reply = lastReply(tempHost);
            expect(reply.content).toBe(finalText);
            expect(reply.usage).toEqual(expect.objectContaining({ inputTokens: 11, outputTokens: 22 }));
        });
    });

    test('非流式 /agent：同样不退回截断点之前的中间说明', async () => {
        const finalText = '非流式：全部完成。';
        await withServer(bigOutputStream(finalText, 5000), { agentRawOutputMaxChars: 2000 }, async ({ baseUrl, cookie }) => {
            const res = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'go', clientMessageId: 'final-reply-0002' })
            });
            expect(res.json.output).toBe(finalText);
        });
    });

    test('超过 16000 字的最终回复不被截断', async () => {
        const finalText = '长回复：' + '这是一段用来撑长度的报告正文。'.repeat(1500);
        expect(finalText.length).toBeGreaterThan(20000);
        await withServer(bigOutputStream(finalText, 10), {}, async ({ baseUrl, cookie, tempHost }) => {
            const events = await readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'go', clientMessageId: 'final-reply-0003' })
            });
            expect(events.find(event => event.type === 'result').output).toBe(finalText);
            expect(lastReply(tempHost).content).toBe(finalText);
        });
    });

    test('真实样本（后台任务）：结尾两个 result，取最后的最终结论', () => {
        const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-background-task.ndjson'), 'utf-8');
        const reply = extractAgentMessageFromStructuredOutput('claude', fixture);
        expect(reply.startsWith('后台子 agent 已完成，最终结论如下')).toBe(true);
        expect(reply).not.toContain('前台结果已出');
    });

    test('Claude：result 事件晚于最后一条正文时以 result 为准', () => {
        const text = assistantText('中间说明') + line({ type: 'result', subtype: 'success', result: '权威的最终文本' });
        expect(extractAgentMessageFromStructuredOutput('claude', text)).toBe('权威的最终文本');
    });

    test('Claude：出错的 result 带错误文本时以它为准（这一轮以出错结束，最后一条正文只是中间说明）', () => {
        const text = assistantText('中间说明') + line({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: overloaded' });
        expect(extractAgentMessageFromStructuredOutput('claude', text)).toBe('API Error: overloaded');
    });

    test('超大的最终回复有上限，末尾标明已截断', async () => {
        const finalText = '超大：' + 'x'.repeat(1100000);
        await withServer(bigOutputStream(finalText, 10), {}, async ({ baseUrl, cookie }) => {
            const events = await readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'go', clientMessageId: 'final-reply-0004' })
            });
            const output = events.find(event => event.type === 'result').output;
            expect(output.length).toBeLessThan(1000100);
            expect(output.endsWith('...[truncated]')).toBe(true);
        });
    });

    test('Claude：出错的 result 没有 result 字段时保留最后一条正文', () => {
        const text = assistantText('最后一句') + line({ type: 'result', subtype: 'error_max_turns', is_error: true });
        expect(extractAgentMessageFromStructuredOutput('claude', text)).toBe('最后一句');
    });
});
