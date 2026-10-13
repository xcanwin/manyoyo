'use strict';

// 停止 / 打断容器里的 Agent 进程。
// 宿主机上的 `docker exec` 客户端被杀后，容器里的进程常常还活着（实测：kill 客户端后 `sleep 600` 仍在），
// 所以要进到容器里，按进程组发信号：INT（让这一轮干净结束）→ TERM → KILL，最后才收宿主机上的客户端。
//
// 约定：命令前面加一句把自己的 PID 写进容器里的 /tmp/manyoyo-run-<id>.pid（wrapAgentCommand），再运行真正的命令；
// 这条命令行本身就带着 `manyoyo-run-<id>.pid`，所以 /proc/<pid>/cmdline 就是“这个进程属于这次运行”的标记。
// PID 文件在容器里、容器内进程可写，按不可信输入处理：内容必须是纯数字，并且该进程的环境里
// 命令行里必须有本次运行的标记，才会发信号（见 RUN_KILL_SCRIPT）。

const crypto = require('crypto');

const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const KILL_SIGNALS = new Set(['INT', 'TERM', 'KILL']);
const DEFAULT_GRACE_MS = 3000;

function isValidRunId(value) {
    return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

function createRunId() {
    return crypto.randomUUID();
}

function pidFilePath(runId) {
    return `/tmp/manyoyo-run-${runId}.pid`;
}

// 仍然是 `/bin/bash -lc <命令>` 的单个字符串参数（原命令原样保留，不套引号）。
// 容器里的 exec 进程不是进程组长（实测 PGID/SID 都是 0），所以停的时候走子孙进程树，不依赖进程组
function wrapAgentCommand(command, runId) {
    if (!isValidRunId(runId)) throw new Error(`runId 非法: ${runId}`);
    // 末尾的 `exit $?` 不能省：命令是最后一条简单命令时 bash 会 exec 替换自己，命令行里的标记随之消失，停止时就认不出这个进程
    return `echo $$ > ${pidFilePath(runId)}; ${command}; exit $?`;
}


// 在容器里执行（参数：$1 = runId，$2 = 信号）。只认纯数字 PID、普通文件（不跟符号链接）、
// 且进程命令行里带本次的 manyoyo-run-<id>.pid 标记；先发给整个进程组，失败再发给进程本身
const RUN_KILL_SCRIPT = [
    'f="/tmp/manyoyo-run-$1.pid"',
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 0',
    'pid="$(head -c 16 "$f" 2>/dev/null | tr -d "\\n")"',
    'case "$pid" in ""|*[!0-9]*) exit 3;; esac',
    '[ "$pid" -gt 1 ] || exit 3',
    'tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "manyoyo-run-$1.pid" || exit 4',
    // 本进程和它的全部子孙（agent 派生的子进程）；先收集再发信号
    'descendants() { for c in $(ps -eo pid=,ppid= | awk -v p="$1" \'$2 == p { print $1 }\'); do echo "$c"; descendants "$c"; done; }',
    'all="$pid $(descendants "$pid")"',
    'for p in $all; do kill -"$2" "$p" 2>/dev/null; done',
    'exit 0'
].join('\n');

function buildRunKillCommand(runId, signal) {
    if (!isValidRunId(runId)) throw new Error(`runId 非法: ${runId}`);
    if (!KILL_SIGNALS.has(signal)) throw new Error(`信号不允许: ${signal}`);
    return ['/bin/sh', '-c', RUN_KILL_SCRIPT, 'sh', runId, signal];
}

/**
 * INT → TERM → KILL 逐级升级，每级等 graceMs，进程退出就停；最后兜底收宿主机上的客户端。
 * @param {{ runState: object, killInContainer: (runId: string, signal: string) => Promise<void>|void, sleep?: Function, graceMs?: number }} options
 *   runState.closed 是 Promise（进程 close 时 resolve），runState.process 是宿主机上的客户端子进程
 */
async function terminateRun({ runState, killInContainer, graceMs = DEFAULT_GRACE_MS, signals = ['INT', 'TERM', 'KILL'] }) {
    const exited = () => Promise.race([
        runState.closed.then(() => true),
        new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), graceMs);
            if (typeof timer.unref === 'function') timer.unref();
        })
    ]);
    if (isValidRunId(runState.runId)) {
        for (const signal of signals) {
            try {
                await killInContainer(runState.runId, signal);
            } catch (error) {
                // 容器可能已经没了：继续往下收客户端
            }
            if (await exited()) return 'exited';
        }
    }
    try {
        if (runState.process) runState.process.kill('SIGKILL');
    } catch (error) {
        // 进程可能已退出
    }
    return 'client-killed';
}

module.exports = {
    RUN_ID_PATTERN,
    RUN_KILL_SCRIPT,
    DEFAULT_GRACE_MS,
    isValidRunId,
    createRunId,
    wrapAgentCommand,
    buildRunKillCommand,
    pidFilePath,
    terminateRun
};
