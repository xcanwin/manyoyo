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

setsid bash -c "$(declare -f log load_env run_autostart); BOX=$BOX SYS=$SYS GATE=$GATE LOG=$LOG; run_autostart" >/dev/null 2>&1 &

while :; do sleep 3600 & wait $!; done
