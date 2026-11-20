'use strict';

// 真实容器：共享技能只读挂载 + 受管链接；共享 MCP 经 Agent 原生 CLI 下发（Claude / Codex）。
// 运行时不可用或镜像缺失时自动跳过；临时 HOME，只建 qa-shared-* 容器，结束按创建清单删除。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const store = require('../../lib/extensions-store');
const applyLib = require('../../lib/extensions-apply');
const { makeSidecarSafeHome } = require('./helpers/sidecar-home');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
const IMAGE = `${IMAGE_NAME}:${imageVersion}`;
let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', IMAGE], { stdio: 'ignore', env }).status !== 0) skipReason = `本机没有镜像 ${IMAGE}`;
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[shared-extensions 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rtSync(args, options = {}) {
    return spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env }, timeout: 90000, ...options });
}

function rtAsync(args, { input, timeout = 90000 } = {}) {
    return new Promise(resolve => {
        const child = spawn(runtime.command, args, { env: { ...process.env, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

// 与 buildExecArgs 相同：MCP 的 env 值经 0600 临时 env 文件传给 exec，不进宿主机 argv
function containerRunner(name) {
    return (args, opts = {}) => {
        let envFile = '';
        if (Array.isArray(opts.extraEnv) && opts.extraEnv.length) {
            envFile = path.join(os.tmpdir(), `manyoyo-ext-env-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
            fs.writeFileSync(envFile, `${opts.extraEnv.join('\n')}\n`, { mode: 0o600 });
        }
        const full = ['exec', ...(opts.stdin !== undefined ? ['-i'] : []), ...(envFile ? ['--env-file', envFile] : []), name, ...args];
        return rtAsync(full, { input: opts.stdin, timeout: opts.timeoutMs }).finally(() => {
            if (envFile) fs.rmSync(envFile, { force: true });
        });
    };
}

const ECHO_MCP = `const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } };
  else if (msg.method === 'tools/list') result = { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`;

maybe('共享技能与 MCP（真实容器）', () => {
    let home;
    let work;
    let name;
    let id;
    const secrets = [`sk-test-${crypto.randomBytes(6).toString('hex')}`];

    beforeAll(async () => {
        home = makeSidecarSafeHome('manyoyo-shared-ext-home-');
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-shared-ext-work-'));
        fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
        store.writeSkill(home, 'common', 'shared-demo', '---\nname: shared-demo\ndescription: 共享技能演示\n---\n正文\n');
        store.saveMcp(home, {
            name: 'echo',
            agents: ['claude', 'codex'],
            transport: 'stdio',
            command: 'node',
            args: ['/tmp/echo-mcp.js'],
            env: [{ key: 'ECHO_TOKEN', value: secrets[0] }]
        });
        name = `qa-shared-${crypto.randomBytes(3).toString('hex')}`;
        const st = require('../../lib/container-state').createState({
            homeDir: home,
            network: require('../../lib/network-policy').normalizePolicy({}),
            netRequired: true,
            meta: { name }
        });
        id = st.id;
        const { buildContainerRunArgs } = require('../../lib/container-run');
        const args = buildContainerRunArgs({
            state: st,
            extensionsSkillsDir: store.skillsMountDir(home),
            defaultNetwork: 'manyoyo',
            containerName: name,
            hostPath: work,
            containerPath: work,
            imageName: IMAGE_NAME,
            imageVersion,
            defaultCommand: '/bin/bash',
            containerExtraArgs: path.basename(runtime.command) === 'docker' ? ['--add-host', 'host.docker.internal:host-gateway'] : []
        });
        const created = rtSync(args);
        if (created.status !== 0) throw new Error(created.stderr);
        const manager = require('../../lib/container-network').createNetworkManager({ command: runtime.command, env: runtime.env, homeDir: home, imageRef: () => IMAGE });
        await manager.ensureBridgeNetwork();
        const gate = await manager.apply(name, { expectId: id });
        if (gate.status !== 'applied') throw new Error(`网络规则下发失败: ${gate.message || gate.status}`);
    }, 180000);

    afterAll(async () => {
        if (name) rtSync(['rm', '-f', name]);
        const hash = crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 8);
        rtSync(['rm', '-f', `manyoyo-egress-${hash}`]);
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    }, 120000);

    test('新容器只读挂载共享技能目录，容器 home 里是指向共享目录的受管链接；共享状态可读', async () => {
        const mounted = rtSync(['exec', name, 'sh', '-lc', 'cat /run/manyoyo-extensions/skills/common/shared-demo/SKILL.md']);
        expect(mounted.status).toBe(0);
        expect(mounted.stdout).toContain('共享技能演示');

        const applyResult = await applyLib.applyExtensions({
            homeDir: home,
            containerName: name,
            containerId: id,
            mode: 'mount',
            workDir: work,
            runInContainer: containerRunner(name),
            copySkill: async (source, dest) => {
                const result = rtSync(['cp', source, `${name}:${dest}`]);
                if (result.status !== 0) throw new Error(result.stderr);
            }
        });
        expect(applyResult.applied).toBe(true);

        const link = rtSync(['exec', name, 'sh', '-lc', 'readlink ~/.claude/skills/shared-demo']);
        expect(link.stdout.trim()).toBe('/run/manyoyo-extensions/skills/common/shared-demo');
        // 共享目录只读
        const write = rtSync(['exec', name, 'sh', '-lc', 'touch /run/manyoyo-extensions/skills/common/shared-demo/x 2>&1 || true']);
        expect(write.stdout).toMatch(/Read-only|read-only|Permission denied/i);

        const stateFile = path.join(home, '.manyoyo', 'extensions', 'state', `${id}.json`);
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state).toEqual(expect.objectContaining({ mode: 'mount', skills: expect.objectContaining({ claude: ['shared-demo'], codex: ['shared-demo'] }) }));
        expect(JSON.stringify(state)).not.toContain(secrets[0]);
    }, 120000);

    test('共享 MCP：Claude 能连上 stdio echo，Codex 配置可见；密钥值不出现在宿主机 ps 参数里', async () => {
        // 容器内的 echo MCP 脚本（模拟一个最小 MCP server）
        const wrote = rtAsync(['exec', '-i', name, 'sh', '-c', 'cat > /tmp/echo-mcp.js'], { input: ECHO_MCP });
        expect((await wrote).code).toBe(0);
        const applied = await applyLib.applyExtensions({
            homeDir: home,
            containerName: name,
            containerId: id,
            mode: 'mount',
            workDir: work,
            force: true,
            runInContainer: containerRunner(name),
            copySkill: async () => {}
        });
        expect(applied.warnings.filter(message => /MCP/.test(message))).toEqual([]);

        const claudeConfig = rtSync(['exec', name, 'sh', '-lc', 'node -e "const j=require(\'/root/.claude.json\');console.log(JSON.stringify(j.mcpServers||{}))"']);
        expect(claudeConfig.stdout).toContain('"echo"');
        expect(claudeConfig.stdout).toContain('"ECHO_TOKEN"');

        const codexConfig = rtSync(['exec', name, 'sh', '-lc', 'codex mcp list --json']);
        expect(codexConfig.status).toBe(0);
        expect(codexConfig.stdout).toContain('"echo"');
        expect(codexConfig.stdout).toContain(secrets[0]);

        // Claude 真实连接（最长 30 秒）：成功时行尾是 ✓
        const listed = await rtAsync(['exec', name, 'sh', '-lc', 'claude mcp list'], { timeout: 60000 });
        expect(listed.stdout).toContain('echo');
        expect(listed.stdout).toMatch(/✔|✓|Connected/);

        // 下发期间的容器内 bash 脚本走 stdin：宿主机 ps 里看不到令牌（容器内 root 仍能看到，见文档）
        const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf-8' });
        expect(ps.stdout).not.toContain(secrets[0]);
    }, 180000);
});
