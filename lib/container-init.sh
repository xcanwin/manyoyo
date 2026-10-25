#!/bin/bash
# manyoyo 容器 PID 1：回收僵尸、响应 SIGTERM、在（网络规则就绪后）运行自启动脚本。
# 由宿主机以只读目录挂到 /run/manyoyo-sys/，容器内不可改。
BOX=/run/manyoyo
SYS=/run/manyoyo-sys
GATE=/run/manyoyo-gate
LOG="$BOX/autostart.log"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null; }

trap 'kill -TERM -1 2>/dev/null; exit 0' TERM INT

. "$SYS/env.sh"

# 日志超过 256 KiB 时只保留尾部 128 KiB
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
    tail -c 131072 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
fi

run_autostart() {
    if [ -e "$SYS/net-required" ]; then
        log "等待 manyoyo 下发网络规则"
        while [ ! -e "$GATE/ready" ]; do sleep 0.5; done
        log "网络规则已就绪"
    fi
    if [ ! -s "$BOX/autostart.sh" ]; then
        log "没有自启动命令"
        exit 0
    fi
    load_env "$SYS/managed.env"
    load_env "$SYS/files.env"
    load_env "$BOX/env"
    log "开始运行自启动脚本"
    /bin/bash "$BOX/autostart.sh" >> "$LOG" 2>&1
    log "自启动脚本退出，退出码 $?"
}

# trust_workdir:预先信任容器的工作目录,交互式 claude / codex 首次启动不再停在“信任此文件夹”。
# 任何失败都静默,不影响 init。目录只经环境变量传给 node,不拼进脚本文本。
# BEGIN trust_workdir
trust_workdir() {
    local dir
    dir=$(pwd -P 2>/dev/null) || return 0
    [ -n "$dir" ] || return 0
    if [ -f "$HOME/.claude.json" ] && command -v node >/dev/null 2>&1; then
        TRUST_DIR="$dir" node -e '
const fs = require("fs");
const file = process.env.HOME + "/.claude.json";
const dir = process.env.TRUST_DIR;
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { process.exit(0); }
if (!data || typeof data !== "object" || Array.isArray(data)) process.exit(0);
if (!data.projects || typeof data.projects !== "object") data.projects = {};
const project = data.projects[dir] && typeof data.projects[dir] === "object" ? data.projects[dir] : {};
if (project.hasTrustDialogAccepted === true) process.exit(0);
project.hasTrustDialogAccepted = true;
data.projects[dir] = project;
const tmp = file + ".manyoyo-tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: fs.statSync(file).mode & 0o777 });
fs.renameSync(tmp, file);
' >/dev/null 2>&1
    fi
    if [ -f "$HOME/.codex/config.toml" ]; then
        case "$dir" in
            *[\"\\]*|*[[:cntrl:]]*) return 0 ;;
        esac
        grep -qxF "[projects.\"$dir\"]" "$HOME/.codex/config.toml" 2>/dev/null \
            || printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$dir" >> "$HOME/.codex/config.toml" 2>/dev/null
    fi
    return 0
}
# END trust_workdir
(trust_workdir) >/dev/null 2>&1 &

setsid bash -c "$(declare -f log load_env run_autostart); BOX=$BOX SYS=$SYS GATE=$GATE LOG=$LOG; run_autostart" >/dev/null 2>&1 &

while :; do sleep 3600 & wait $!; done
