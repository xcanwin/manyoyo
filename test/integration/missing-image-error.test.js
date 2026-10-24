'use strict';

// 镜像本地不存在时，当前运行时（docker 优先，与被测代码同一套选择）的报错必须能被 isMissingImageError 认出来，
// 否则一次性 helper 不会回退到容器自己的镜像。运行时不可用时自动跳过。
const { spawnSync } = require('child_process');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { isMissingImageError } = require('../../lib/container-network');

let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[missing-image-error 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

maybe('镜像缺失的报错（真实运行时）', () => {
    test('run --pull=never 一个不存在的镜像：报错能被 isMissingImageError 认出', () => {
        const result = spawnSync(runtime.command, ['run', '--rm', '--pull=never', 'localhost/manyoyo-no-such-image:0.0.0', 'true'], {
            encoding: 'utf-8',
            env: { ...process.env, ...runtime.env },
            timeout: 60000
        });
        expect(result.status).not.toBe(0);
        const output = `${result.stdout}${result.stderr}`;
        // 原始报错行写进测试输出，docker 的真实文案以 CI 日志为准
        console.log(`[${runtime.command}] ${output.trim()}`);
        expect(isMissingImageError(output)).toBe(true);
    });
});
