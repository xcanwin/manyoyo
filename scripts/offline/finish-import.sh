#!/bin/sh
# 后台导入镜像：由 install.sh 启动，安装完成后继续运行。
# 成功：写入完成标记并删除归档；失败：保留归档与失败说明，重跑安装包会再次导入。
set -u

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >> "$MANYOYO_IMPORT_LOG"; }

printf '{"pid": %s, "message": "正在导入离线镜像"}\n' "$$" > "$MANYOYO_IMPORT_MARKER"
trap 'rm -f "$MANYOYO_IMPORT_MARKER"' EXIT

if [ "$MANYOYO_IMPORT_KIND" = private ]; then
    export XDG_CONFIG_HOME="$MANYOYO_IMPORT_PODMAN_ROOT/config"
    export XDG_DATA_HOME="$MANYOYO_IMPORT_PODMAN_ROOT/data"
    export CONTAINERS_CONF="$MANYOYO_IMPORT_PODMAN_ROOT/containers.conf"
    runtime="$MANYOYO_IMPORT_PODMAN_ROOT/bin/podman"
else
    runtime="$MANYOYO_IMPORT_CMD"
fi

log "导入 ${MANYOYO_IMPORT_ARCHIVE}（${runtime}）"
if "$runtime" load -i "$MANYOYO_IMPORT_ARCHIVE" >> "$MANYOYO_IMPORT_LOG" 2>&1; then
    : > "$MANYOYO_IMPORT_STATE"
    rm -f "$MANYOYO_IMPORT_ARCHIVE"
    log "导入完成，已删除临时归档"
else
    log "导入失败：归档保留在 ${MANYOYO_IMPORT_ARCHIVE}，重新运行安装包即可重试"
    exit 1
fi
