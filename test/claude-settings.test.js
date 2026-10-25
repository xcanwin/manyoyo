'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SETTINGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docker', 'res', 'claude', 'settings.json'), 'utf8'));

// 镜像里 Claude 的 Stop hook：任务完成响铃。实测结论（Claude Code 2.1.304）：
// - hook 在独立会话里运行，没有控制终端，写 /dev/tty 不会响；stdout 被 Claude 捕获，裸 printf '\a' 也不会响；
// - 在 dash 下 `: > /dev/tty` 失败会让 shell 以退出码 2 退出，Stop hook 退出码 2 会让 Claude 不停重跑；
// - 正确做法是输出 {"terminalSequence":"\u0007"}（只对用户级设置生效）；
// - -p 模式（网页）下 stdout 不能混进任何非 JSON 字节，所以只在 CLAUDE_CODE_ENTRYPOINT=cli 时输出。
describe('docker/res/claude/settings.json 的 Stop hook', () => {
    const hooks = (SETTINGS.hooks && SETTINGS.hooks.Stop && SETTINGS.hooks.Stop[0] && SETTINGS.hooks.Stop[0].hooks) || [];

    test('保留原有字段，Stop 事件下是三个并行 command hook', () => {
        expect(SETTINGS.statusLine).toEqual({ type: 'command', command: 'bash /root/.claude/statusline.sh' });
        expect(SETTINGS.attribution).toBeDefined();
        expect(SETTINGS.hooks.Stop).toHaveLength(1);
        expect(SETTINGS.hooks.Stop[0].matcher).toBeUndefined();
        expect(hooks).toHaveLength(3);
        hooks.forEach(hook => expect(hook.type).toBe('command'));
    });

    function run(command, entrypoint, bell) {
        return spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { PATH: process.env.PATH, ...(entrypoint ? { CLAUDE_CODE_ENTRYPOINT: entrypoint } : {}), ...(bell === undefined ? {} : { MANYOYO_CLAUDE_BELL: bell }) } });
    }

    test('交互终端（cli）：输出只含 BEL 的 terminalSequence，退出码 0', () => {
        for (const hook of hooks) {
            const result = run(hook.command, 'cli');
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({ terminalSequence: '\u0007' });
        }
    });

    test('网页（sdk-cli）或没有环境变量：什么都不输出、不等待、退出码 0', () => {
        for (const entrypoint of ['sdk-cli', '']) {
            for (const hook of hooks) {
                const started = Date.now();
                const result = run(hook.command, entrypoint);
                expect(result.status).toBe(0);
                expect(result.stdout).toBe('');
                expect(Date.now() - started).toBeLessThan(400);
            }
        }
    });

    test('三个 hook 错开约 0.3 秒，响三声', () => {
        const delays = hooks.map(hook => Number((hook.command.match(/sleep ([0-9.]+)/) || [])[1]));
        expect(delays).toEqual([0, 0.3, 0.6]);
    });

    test('MANYOYO_CLAUDE_BELL：0 不响、1 一声、3 三声，未设置或非法值按 3；退出码一律 0', () => {
        const expected = { 0: 0, 1: 1, 3: 3, abc: 3, 2: 3, '': 3, undefined: 3 };
        for (const [bell, count] of Object.entries(expected)) {
            const value = bell === 'undefined' ? undefined : bell;
            const results = hooks.map(hook => run(hook.command, 'cli', value));
            results.forEach(result => expect(result.status).toBe(0));
            expect(results.filter(result => result.stdout !== '').length).toBe(count);
        }
    });

    test('MANYOYO_CLAUDE_BELL 在网页（sdk-cli）下也不输出', () => {
        for (const bell of ['0', '1', '3']) {
            hooks.forEach(hook => expect(run(hook.command, 'sdk-cli', bell).stdout).toBe(''));
        }
    });
});
