'use strict';

// 导出 / 导入用的容器运行时封装（docker / podman 命令行）。
// 导出导入的核心逻辑只依赖这里的接口，测试里用假实现替换。

const { spawn, spawnSync } = require('child_process');

function createCliRuntime({ command, env }) {
    const sync = (args, options = {}) => spawnSync(command, args, { env: env || process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
    const must = (args, what) => {
        const result = sync(args);
        if (result.status !== 0) throw new Error(`${what}失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
        return result.stdout;
    };

    return {
        // 容器信息；容器不存在返回 null
        inspect(name) {
            const result = sync(['inspect', '--format', '{{json .}}', name]);
            if (result.status !== 0) return null;
            let data;
            try {
                data = JSON.parse(result.stdout.split('\n')[0]);
            } catch (error) {
                return null;
            }
            const labels = (data.Config && data.Config.Labels) || {};
            return {
                id: labels['manyoyo.id'] || '',
                image: (data.Config && data.Config.Image) || '',
                status: data.State && data.State.Paused ? 'paused' : (data.State && data.State.Running ? 'running' : 'stopped'),
                mounts: (data.Mounts || []).map(item => item.Destination).filter(Boolean),
                defaultCmd: labels['manyoyo.default_cmd'] || ''
            };
        },
        pause(name) {
            must(['pause', name], '暂停容器');
        },
        unpause(name) {
            must(['unpause', name], '恢复容器');
        },
        // 暂停不可用时的退路：停止 / 启动（启动会重新跑自启动脚本）
        stop(name) {
            must(['stop', '-t', '10', name], '停止容器');
        },
        start(name) {
            must(['start', name], '启动容器');
        },
        diff(name) {
            return must(['diff', name], '读取容器改动');
        },
        // 返回 { stream, done }：stream 是 tar 输出；done 在进程结束后给出 { code, stderr }
        cp(name, containerPath) {
            const child = spawn(command, ['cp', `${name}:${containerPath}`, '-'], { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
            const done = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
            child.on('error', error => child.stdout.destroy(error));
            return { stream: child.stdout, done, kill: () => child.kill('SIGKILL') };
        },
        // 把 tar 流写进容器：返回 { stdin, done }
        cpIn(name, containerPath) {
            const child = spawn(command, ['cp', '-', `${name}:${containerPath}`], { env: env || process.env, stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
            const done = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
            return { stdin: child.stdin, done, kill: () => child.kill('SIGKILL') };
        }
    };
}

module.exports = { createCliRuntime };
