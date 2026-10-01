#!/bin/sh
# MANYOYO 离线安装器（POSIX sh，只用 macOS 自带命令；不联网、不用 brew/git/python3）。
# 由 .run 头部解开负载后调用：sh install/install.sh [--no-open]
# 幂等：每一步先检测，已完成就跳过；中途失败直接重跑即可续上。日志：~/.manyoyo/logs/install/
#
# 测试钩子（仅用于测试，发布包默认不设置）：
#   MANYOYO_TEST_HOME / _UNAME_S / _UNAME_M / _MACOS_VERSION / _FREE_MB / _SHELL
#   MANYOYO_TEST_SKIP_MACHINE=1  跳过 podman machine 步骤
#   MANYOYO_TEST_SKIP_OPEN=1     安装后不启动 manyoyo / 不打开浏览器
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$here/install/env.sh"

OPEN_AFTER=1
for arg in "$@"; do
    case "$arg" in
        --no-open) OPEN_AFTER=0 ;;
        -h|--help) echo "用法: sh manyoyo-*.run [--no-open]"; exit 0 ;;
        *) echo "未知参数: $arg" >&2; exit 2 ;;
    esac
done
[ "${MANYOYO_TEST_SKIP_OPEN:-0}" = 1 ] && OPEN_AFTER=0

HOME_DIR="${MANYOYO_TEST_HOME:-$HOME}"
ROOT="$HOME_DIR/.manyoyo"
STATE="$ROOT/.install"
LOG_DIR="$ROOT/logs/install"
PODMAN_ROOT="$ROOT/runtime/podman"
IMPORT_DIR="$ROOT/runtime/import"
mkdir -p "$LOG_DIR" "$STATE"
LOG="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"

log() {
    printf '%s\n' "$*"
    printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"
}

# 失败：原因 + 下一步，退出码 1
fail() {
    log "✗ 安装失败：$1"
    log "  下一步：$2"
    log "  日志：$LOG（修好后直接重新运行安装包即可续上）"
    exit 1
}

# 执行命令并把输出追加到日志；返回命令的退出码
run() {
    "$@" >> "$LOG" 2>&1
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi
}

# macOS 没有 timeout 命令：后台跑 + 看门狗
with_timeout() {
    secs="$1"; shift
    "$@" >/dev/null 2>&1 &
    cmd_pid=$!
    ( sleep "$secs"; kill "$cmd_pid" 2>/dev/null ) >/dev/null 2>&1 &
    watcher=$!
    status=0
    wait "$cmd_pid" 2>/dev/null || status=$?
    kill "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    return "$status"
}

# ---------------------------------------------------------------------------
# 1. 环境检查
# ---------------------------------------------------------------------------
check_platform() {
    step_os="${MANYOYO_TEST_UNAME_S:-$(uname -s)}"
    [ "$step_os" = Darwin ] || fail "这个安装包只支持 macOS（当前系统：$step_os）。" "请在 Mac 上运行；Linux / Windows 暂不支持。"

    raw_arch="${MANYOYO_TEST_UNAME_M:-$(uname -m)}"
    case "$raw_arch" in
        arm64) cur_arch=arm64 ;;
        x86_64) cur_arch=x64 ;;
        *) fail "不认识的 CPU 架构：$raw_arch。" "请使用 Apple Silicon（arm64）或 Intel（x64）的 Mac。" ;;
    esac
    [ "$cur_arch" = "$MANYOYO_ARCH" ] || fail "安装包是 $MANYOYO_ARCH 版，但当前终端是 $cur_arch。" "请下载 $cur_arch 对应的安装包；如果你在 Apple Silicon 上看到 x64，说明终端在 Rosetta 下运行，请换原生终端。"

    mac_version="${MANYOYO_TEST_MACOS_VERSION:-$(sw_vers -productVersion)}"
    mac_major="${mac_version%%.*}"
    [ "$mac_major" -ge "$MANYOYO_MIN_MACOS" ] 2>/dev/null || fail "macOS 版本过低：$mac_version，需要 $MANYOYO_MIN_MACOS 或更高。" "请先升级 macOS，或改用文档里的其它安装方式。"

    free_mb="${MANYOYO_TEST_FREE_MB:-$(df -k "$HOME_DIR" | awk 'NR==2 { print int($4 / 1024) }')}"
    [ "$free_mb" -ge "$MANYOYO_MIN_FREE_MB" ] 2>/dev/null || fail "磁盘空间不足：可用约 ${free_mb}MB，至少需要 ${MANYOYO_MIN_FREE_MB}MB。" "清理磁盘后重新运行安装包。"
}

# daemon 可用的 docker / podman（沿用 T02 的“daemon 可用优先”规则，这里只做最小判断，其余交给 manyoyo）
detect_external_runtime() {
    for candidate in docker podman; do
        if command -v "$candidate" >/dev/null 2>&1 && with_timeout 5 "$candidate" info; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------------------
# 2. 解压到 ~/.manyoyo
# ---------------------------------------------------------------------------
clear_quarantine() {
    if command -v xattr >/dev/null 2>&1; then
        xattr -dr com.apple.quarantine "$1" >/dev/null 2>&1 || true
    fi
}

install_app() {
    app_dir="$ROOT/app/$MANYOYO_VERSION"
    if [ -f "$app_dir/.installed" ] && [ "$(cat "$app_dir/.installed")" = "$MANIFEST_SHA" ]; then
        log "• 应用 $MANYOYO_VERSION 已安装，跳过"
    else
        log "▶ 安装应用 $MANYOYO_VERSION"
        mkdir -p "$ROOT/app"
        rm -rf "$ROOT/app/.tmp-$MANYOYO_VERSION" "$app_dir"
        mv "$here/app" "$ROOT/app/.tmp-$MANYOYO_VERSION" || fail "无法写入 $ROOT/app。" "检查该目录的权限和磁盘空间。"
        printf '%s' "$MANIFEST_SHA" > "$ROOT/app/.tmp-$MANYOYO_VERSION/.installed"
        mv "$ROOT/app/.tmp-$MANYOYO_VERSION" "$app_dir"
        clear_quarantine "$app_dir"
    fi
    ln -sfn "$MANYOYO_VERSION" "$ROOT/app/current"
}

install_podman() {
    if [ -f "$PODMAN_ROOT/.installed" ] && [ "$(cat "$PODMAN_ROOT/.installed")" = "$MANIFEST_SHA" ]; then
        log "• 私有 Podman 已安装，跳过"
        return 0
    fi
    log "▶ 安装私有 Podman（$MANYOYO_PODMAN_VERSION）"
    mkdir -p "$PODMAN_ROOT"
    # 只替换程序目录；config/ 与 data/（machine、镜像存储）属于用户数据，重装不能动
    for sub in bin lib share; do
        rm -rf "$PODMAN_ROOT/$sub"
        [ -d "$here/runtime/podman/$sub" ] && mv "$here/runtime/podman/$sub" "$PODMAN_ROOT/$sub"
    done
    clear_quarantine "$PODMAN_ROOT"
    mkdir -p "$PODMAN_ROOT/config" "$PODMAN_ROOT/data"
    printf '%s' "$MANIFEST_SHA" > "$PODMAN_ROOT/.installed"
}

write_podman_conf() {
    # 抄入用户已有的代理设置（私有 Podman 设了 CONTAINERS_CONF，不会再读用户自己的 containers.conf）
    node_bin="$ROOT/app/current/node/bin/node"
    run "$node_bin" "$ROOT/app/current/manyoyo/lib/proxy-config.js" --write-conf "$PODMAN_ROOT" "$HOME_DIR" \
        || fail "生成私有 Podman 配置失败。" "查看日志里 proxy-config 的输出，或删除 $PODMAN_ROOT/containers.conf 后重试。"
}

# ---------------------------------------------------------------------------
# 3. 命令与 PATH
# ---------------------------------------------------------------------------
write_wrapper() {
    name="$1"
    mkdir -p "$ROOT/bin"
    cat > "$ROOT/bin/$name" <<'WRAP'
#!/bin/sh
# 由 MANYOYO 离线安装器生成；升级时只切换 app/current
d="$(cd "$(dirname "$0")/.." && pwd)"
export MANYOYO_COMMAND_NAME=@NAME@
exec "$d/app/current/node/bin/node" "$d/app/current/manyoyo/bin/manyoyo.js" "$@"
WRAP
    sed "s/@NAME@/$name/" "$ROOT/bin/$name" > "$ROOT/bin/$name.tmp" && mv "$ROOT/bin/$name.tmp" "$ROOT/bin/$name"
    chmod 755 "$ROOT/bin/$name"
}

add_path_block() {
    target="$1"
    touch "$target"
    if grep -q '^# >>> manyoyo >>>$' "$target"; then
        return 0
    fi
    if [ -s "$target" ] && [ "$(tail -c 1 "$target" | wc -l | tr -d ' ')" = 0 ]; then
        printf '\n' >> "$target"
    fi
    {
        printf '\n'
        printf '%s\n' '# >>> manyoyo >>>'
        printf '%s\n' '# 由 MANYOYO 安装器添加；manyoyo uninstall 会移除这一段'
        printf '%s\n' 'case ":$PATH:" in'
        printf '%s\n' '    *":$HOME/.manyoyo/bin:"*) ;;'
        printf '%s\n' '    *) export PATH="$HOME/.manyoyo/bin:$PATH" ;;'
        printf '%s\n' 'esac'
        printf '%s\n' '# <<< manyoyo <<<'
    } >> "$target"
}

setup_path() {
    user_shell="$(basename "${MANYOYO_TEST_SHELL:-${SHELL:-/bin/zsh}}")"
    case "$user_shell" in
        zsh) add_path_block "$HOME_DIR/.zprofile"; add_path_block "$HOME_DIR/.zshrc" ;;
        bash) add_path_block "$HOME_DIR/.bash_profile"; add_path_block "$HOME_DIR/.bashrc" ;;
        *) log "• 没有为 $user_shell 自动写入 PATH，请手动加入：export PATH=\"\$HOME/.manyoyo/bin:\$PATH\"" ;;
    esac
}

# ---------------------------------------------------------------------------
# 4. 私有 Podman machine 与镜像导入
# ---------------------------------------------------------------------------
podman_private() {
    env XDG_CONFIG_HOME="$PODMAN_ROOT/config" XDG_DATA_HOME="$PODMAN_ROOT/data" \
        CONTAINERS_CONF="$PODMAN_ROOT/containers.conf" "$PODMAN_ROOT/bin/podman" "$@"
}

prepare_machine() {
    vm_file="$here/$MANYOYO_VM_FILE"
    if podman_private machine inspect "$MANYOYO_MACHINE_NAME" >/dev/null 2>&1; then
        log "• 虚拟机 $MANYOYO_MACHINE_NAME 已存在，跳过创建"
    else
        [ -f "$vm_file" ] || fail "安装包里没有虚拟机磁盘 $MANYOYO_VM_FILE。" "重新下载安装包并核对 SHA256。"
        log "▶ 创建虚拟机（约 10–20 秒）"
        if ! run podman_private machine init --image "$vm_file" "$MANYOYO_MACHINE_NAME"; then
            run podman_private machine rm -f "$MANYOYO_MACHINE_NAME" || true
            fail "创建虚拟机失败。" "查看日志；常见原因是磁盘空间不足或系统虚拟化被禁用。清理后重新运行安装包。"
        fi
    fi
    if podman_private info >/dev/null 2>&1; then
        log "• 虚拟机已在运行，跳过启动"
    else
        log "▶ 启动虚拟机（约 10–15 秒）"
        run podman_private machine start "$MANYOYO_MACHINE_NAME" \
            || fail "启动虚拟机失败。" "查看日志；如提示 krunkit 异常，请确认 macOS 版本满足要求后重新运行安装包。"
    fi
}

# 把镜像归档移出临时目录（.run 退出后临时目录会被删），交给后台脚本导入并清理
start_image_import() {
    kind="$1"; shift
    if [ -f "$STATE/image-loaded-$MANYOYO_IMAGE_SHA" ]; then
        log "• 镜像已导入，跳过"
        return 0
    fi
    mkdir -p "$IMPORT_DIR"
    if [ -f "$IMPORT_DIR/loading.json" ]; then
        pid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$IMPORT_DIR/loading.json")"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            log "• 镜像导入已在后台进行（pid $pid）"
            return 0
        fi
    fi
    archive="$IMPORT_DIR/$(basename "$MANYOYO_IMAGE_FILE")"
    if [ ! -f "$archive" ]; then
        [ -f "$here/$MANYOYO_IMAGE_FILE" ] || fail "安装包里没有镜像归档 $MANYOYO_IMAGE_FILE。" "重新下载安装包并核对 SHA256。"
        mv "$here/$MANYOYO_IMAGE_FILE" "$archive"
    fi
    cp "$here/install/finish-import.sh" "$IMPORT_DIR/finish.sh"
    log "▶ 在后台导入镜像（约 30–90 秒，向导可以先用）"
    MANYOYO_IMPORT_STATE="$STATE/image-loaded-$MANYOYO_IMAGE_SHA" \
    MANYOYO_IMPORT_MARKER="$IMPORT_DIR/loading.json" \
    MANYOYO_IMPORT_LOG="$LOG_DIR/import.log" \
    MANYOYO_IMPORT_ARCHIVE="$archive" \
    MANYOYO_IMPORT_REF="$MANYOYO_IMAGE_REF" \
    MANYOYO_IMPORT_KIND="$kind" \
    MANYOYO_IMPORT_PODMAN_ROOT="$PODMAN_ROOT" \
    MANYOYO_IMPORT_CMD="${1:-}" \
        nohup sh "$IMPORT_DIR/finish.sh" >/dev/null 2>&1 &
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    log "MANYOYO $MANYOYO_VERSION 离线安装（$MANYOYO_KIND / $MANYOYO_ARCH）"
    check_platform

    MODE=private
    EXTERNAL_CMD=""
    if [ "$MANYOYO_KIND" = full ]; then
        if [ -x "$PODMAN_ROOT/bin/podman" ]; then
            MODE=private
        elif EXTERNAL_CMD="$(detect_external_runtime)"; then
            MODE=external
            log "• 检测到可用的 $EXTERNAL_CMD，复用它，不安装内置 Podman 与虚拟机磁盘"
        fi
    else
        if EXTERNAL_CMD="$(detect_external_runtime)"; then
            MODE=external
        else
            fail "精简包需要已经在运行的 Docker 或 Podman，但没有检测到。" "先启动 Docker Desktop / OrbStack / Podman machine 后重试，或改用包含 Podman 的完整包。"
        fi
    fi

    install_app
    write_wrapper manyoyo
    write_wrapper my

    if [ "$MODE" = private ]; then
        install_podman
        write_podman_conf
        if [ "${MANYOYO_TEST_SKIP_MACHINE:-0}" != 1 ]; then
            prepare_machine
        fi
    fi

    setup_path

    if [ "${MANYOYO_TEST_SKIP_MACHINE:-0}" != 1 ]; then
        if [ "$MODE" = private ]; then
            start_image_import private
        else
            start_image_import external "$EXTERNAL_CMD"
        fi
    fi

    log "✓ 安装完成：$ROOT"
    log "  新开一个终端后可直接输入 manyoyo（当前终端可执行 $ROOT/bin/manyoyo）。"
    log "  安装包（.run 文件）现在可以删除。"

    if [ "$OPEN_AFTER" = 1 ]; then
        "$ROOT/bin/manyoyo" || log "• 自动打开失败，请新开终端后输入 manyoyo"
    fi
}

MANIFEST_SHA="$(sha256_of "$here/manifest.json")"
main
