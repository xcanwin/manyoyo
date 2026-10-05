#!/bin/bash
# manyoyo 容器 PID 1：回收僵尸、响应 SIGTERM、在（网络规则就绪后）运行自启动脚本。
# 由宿主机以只读目录挂到 /run/manyoyo-sys/，容器内不可改。
BOX=/run/manyoyo
SYS=/run/manyoyo-sys
GATE=/run/manyoyo-gate
LOG="$BOX/autostart.log"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null; }

trap 'kill -TERM -1 2>/dev/null; exit 0' TERM INT

# 与宿主机侧同一语义：按第一个 = 切分，不去引号、不展开变量，跳过空行与 # 注释，key 必须合法
load_env() {
    local file=$1 line key
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%$'\r'}
        case $line in ''|'#'*) continue ;; esac
        case $line in *=*) ;; *) continue ;; esac
        key=${line%%=*}
        [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        export "$key=${line#*=}"
    done < "$file"
}

# 日志超过 256 KiB 时只保留尾部 128 KiB
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
    tail -c 131072 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
fi

run_autostart() {
    if [ -e "$SYS/net-required" ]; then
        log "等待 manyoyo 下发网络规则"
        while [ ! -e "$GATE/ready" ]; do sleep 0.5; done
    fi
    [ -s "$BOX/autostart.sh" ] || exit 0
    load_env "$SYS/managed.env"
    load_env "$BOX/env"
    log "开始运行自启动脚本"
    /bin/bash "$BOX/autostart.sh" >> "$LOG" 2>&1
    log "自启动脚本退出，退出码 $?"
}

setsid bash -c "$(declare -f log load_env run_autostart); BOX=$BOX SYS=$SYS GATE=$GATE LOG=$LOG; run_autostart" >/dev/null 2>&1 &

while :; do sleep 3600 & wait $!; done
