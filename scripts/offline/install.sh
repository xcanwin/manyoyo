#!/bin/sh
# MANYOYO 离线安装器（POSIX sh，只用 macOS / Linux 自带命令；不联网、不用 brew/git/python3；只有 Linux 缺容器环境、且用户在终端里同意后，才会执行一条 sudo 安装命令）。
# 由 .run 头部解开负载后调用：sh install/install.sh [--install-only] [--headless|--gui]
# 注意：这是 .run 内部的安装器；用户在终端里 curl | sh 运行的下载引导脚本是仓库里的 scripts/install.sh，它只负责下载、校验并启动 .run。
# Linux 包（MANYOYO_OS=linux）不带 Podman：使用系统里已有的 podman / docker。
# 幂等：每一步先检测，已完成就跳过；中途失败直接重跑即可续上。日志：~/.manyoyo/logs/install/
#
# 测试钩子（仅用于测试，发布包默认不设置）：
#   MANYOYO_TEST_HOME / _UNAME_S / _UNAME_M / _MACOS_VERSION / _GLIBC / _FREE_MB / _SHELL
#   MANYOYO_TEST_OS_RELEASE=<文件>  代替 /etc/os-release；MANYOYO_TEST_TTY=<文件>  代替 /dev/tty（文件内容就是用户的回答）
#   MANYOYO_TEST_SKIP_MACHINE=1  跳过 podman machine 步骤
#   MANYOYO_TEST_SKIP_OPEN=1     安装后不启动 manyoyo / 不打开浏览器
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
. "$here/install/env.sh"

OPEN_AFTER=1
LAUNCH_FLAGS=""
for arg in "$@"; do
    case "$arg" in
        --install-only) OPEN_AFTER=0 ;;
        # 有头 / 无头由 manyoyo 无参启动器判定；这两个参数只是强制覆盖
        --headless|--gui) LAUNCH_FLAGS="$arg" ;;
        -h|--help) echo "用法: sh manyoyo-*.run [--install-only] [--headless|--gui]"; echo "  --install-only  只安装，不启动服务、不打开浏览器、不问配置方式"; exit 0 ;;
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
    log "  日志：${LOG}（修好后直接重新运行安装包即可续上）"
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
    "$@" >"${WT_OUT:-/dev/null}" 2>&1 &
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
    if [ "${MANYOYO_OS:-macos}" = linux ]; then
        check_platform_linux
        return 0
    fi
    step_os="${MANYOYO_TEST_UNAME_S:-$(uname -s)}"
    [ "$step_os" = Darwin ] || fail "这个安装包只支持 macOS（当前系统：${step_os}）。" "请在 Mac 上运行；Linux 请下载 linux 版安装包，Windows 暂不支持。"

    raw_arch="${MANYOYO_TEST_UNAME_M:-$(uname -m)}"
    case "$raw_arch" in
        arm64) cur_arch=arm64 ;;
        x86_64) cur_arch=x64 ;;
        *) fail "不认识的 CPU 架构：${raw_arch}。" "请使用 Apple Silicon（arm64）或 Intel（x64）的 Mac。" ;;
    esac
    [ "$cur_arch" = "$MANYOYO_ARCH" ] || fail "安装包是 $MANYOYO_ARCH 版，但当前终端是 ${cur_arch}。" "请下载 $cur_arch 对应的安装包；如果你在 Apple Silicon 上看到 x64，说明终端在 Rosetta 下运行，请换原生终端。"

    mac_version="${MANYOYO_TEST_MACOS_VERSION:-$(sw_vers -productVersion)}"
    mac_major="${mac_version%%.*}"
    [ "$mac_major" -ge "$MANYOYO_MIN_MACOS" ] 2>/dev/null || fail "macOS 版本过低：${mac_version}，需要 $MANYOYO_MIN_MACOS 或更高。" "请先升级 macOS，或改用文档里的其它安装方式。"

    check_free_space
}

check_free_space() {
    free_mb="${MANYOYO_TEST_FREE_MB:-$(df -k "$HOME_DIR" | awk 'NR==2 { print int($4 / 1024) }')}"
    [ "$free_mb" -ge "$MANYOYO_MIN_FREE_MB" ] 2>/dev/null || fail "磁盘空间不足：可用约 ${free_mb}MB，至少需要 ${MANYOYO_MIN_FREE_MB}MB。" "清理磁盘后重新运行安装包。"
}

# a.b 形式的版本比较：$1 >= $2 返回 0
version_at_least() {
    awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, "."); if (x[1] + 0 != y[1] + 0) exit !(x[1] + 0 > y[1] + 0); exit !(x[2] + 0 >= y[2] + 0) }'
}

check_platform_linux() {
    step_os="${MANYOYO_TEST_UNAME_S:-$(uname -s)}"
    [ "$step_os" = Linux ] || fail "这个安装包只支持 Linux（当前系统：${step_os}）。" "macOS 请下载 macos 版安装包，Windows 暂不支持。"

    raw_arch="${MANYOYO_TEST_UNAME_M:-$(uname -m)}"
    case "$raw_arch" in
        x86_64|amd64) cur_arch=x64 ;;
        aarch64|arm64) cur_arch=arm64 ;;
        *) fail "不认识的 CPU 架构：${raw_arch}。" "请使用 x86_64（x64）或 aarch64（arm64）的 Linux。" ;;
    esac
    [ "$cur_arch" = "$MANYOYO_ARCH" ] || fail "安装包是 $MANYOYO_ARCH 版，但当前机器是 ${cur_arch}。" "请下载 $cur_arch 对应的安装包（uname -m 为 x86_64 选 x64，aarch64 选 arm64）。"

    glibc_raw="${MANYOYO_TEST_GLIBC:-$(getconf GNU_LIBC_VERSION 2>/dev/null || true)}"
    glibc_version="$(printf '%s' "$glibc_raw" | awk '{ print $NF }')"
    [ -n "$glibc_version" ] || fail "没有检测到 glibc（可能是 Alpine 等 musl 系统）。" "请在 Debian 12 / Ubuntu 22.04 或更高版本的发行版上安装。"
    version_at_least "$glibc_version" "$MANYOYO_MIN_GLIBC" || fail "系统 glibc 版本过低：${glibc_version}，需要 $MANYOYO_MIN_GLIBC 或更高（Ubuntu 22.04 / Debian 12 起）。" "请升级发行版，或改用文档里的其它安装方式。"

    check_free_space
}

# 终端：有 /dev/tty 才能问用户；curl | sh 没有终端时只打印命令
TTY_DEV="${MANYOYO_TEST_TTY:-/dev/tty}"
has_tty() {
    [ -r "$TTY_DEV" ] && ( : < "$TTY_DEV" ) 2>/dev/null
}

# 按发行版生成安装某个包的命令（Debian/Ubuntu 用 apt-get，Fedora/RHEL 用 dnf 或 yum）；不认识的发行版返回 1
# 与 lib/rootless-network.js 的 installCommand 保持同一套规则
install_cmd_for() {
    ids="$(sed -n 's/^ID\(_LIKE\)\{0,1\}=//p' "${MANYOYO_TEST_OS_RELEASE:-/etc/os-release}" 2>/dev/null | tr -d "\"'" | tr '[:upper:]' '[:lower:]')"
    for id in $ids; do
        case "$id" in
            debian|ubuntu) echo "sudo apt-get install -y $1"; return 0 ;;
            fedora|rhel|centos)
                if command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y $1"; else echo "sudo yum install -y $1"; fi
                return 0 ;;
        esac
    done
    return 1
}

# 有终端时显示原因与完整命令，征得同意（默认 Y）后执行；成功返回 0。
# 没有终端、用户回答 n、命令执行失败都返回 1，由调用方打印可复制的命令并 fail。
offer_sudo_install() {
    cmd="$1"
    [ -n "$cmd" ] || return 1
    has_tty || return 1
    log "  将执行：${cmd}（会用到 sudo，可能需要输入你的登录密码）"
    printf '  现在执行吗？[默认选Y Y/n] ' > /dev/tty 2>/dev/null || printf '  现在执行吗？[默认选Y Y/n] '
    answer=""
    read -r answer < "$TTY_DEV" || answer=n
    case "$answer" in
        ""|y|Y|yes|YES|Yes) ;;
        *) return 1 ;;
    esac
    sh -c "$cmd" < "$TTY_DEV" || return 1
}

# rootless podman 的默认网络组件缺失时打印组件名（podman 4.x 用 slirp4netns，5.x 起用 pasta）；其余情况没有输出
rootless_network_missing() {
    command -v podman >/dev/null 2>&1 || return 1
    probe="$STATE/podman-probe.txt"
    WT_OUT="$probe" with_timeout 5 podman info --format '{{.Host.Security.Rootless}}' || return 1
    [ "$(tr -d ' \r\n' < "$probe")" = true ] || return 1
    WT_OUT="$probe" with_timeout 5 podman --version || return 1
    major="$(sed -n 's/[^0-9]*\([0-9][0-9]*\)\..*/\1/p' "$probe" | head -n 1)"
    if [ "${major:-0}" -ge 5 ] 2>/dev/null; then comp=pasta; field=Pasta; else comp=slirp4netns; field=Slirp4NetNS; fi
    WT_OUT="$probe" with_timeout 5 podman info --format "{{.Host.${field}.Executable}}" || return 1
    exe="$(tr -d ' \r\n' < "$probe")"
    rm -f "$probe"
    [ -z "$exe" ] || return 1
    echo "$comp"
}

# podman 缺默认网络组件时 info 照样成功，但第一次 run 才会失败：在这里提前查出来，同意后装好
ensure_rootless_network() {
    missing="$(rootless_network_missing)" || return 0
    pkg="$missing"
    [ "$missing" = pasta ] && pkg=passt
    cmd="$(install_cmd_for "$pkg")" || cmd=""
    log "• 检测到 podman，但缺少 rootless 网络组件 ${missing}，没有它容器创建不了网络。"
    if offer_sudo_install "$cmd"; then
        [ -z "$(rootless_network_missing)" ] && { log "✓ 已安装 ${pkg}"; return 0; }
    fi
    if [ -n "$cmd" ]; then
        fail "podman 缺少网络组件 ${missing}。" "执行：${cmd}，然后重新运行安装命令。"
    fi
    fail "podman 缺少网络组件 ${missing}。" "请用系统的包管理器安装 ${pkg}，然后重新运行安装命令。"
}

# Linux 没有可用的 podman / docker：能装就征得同意后装 podman，否则给出“原因 + 下一步”
explain_no_runtime_linux() {
    me="${USER:-$(id -un 2>/dev/null || echo user)}"
    tmp_out="$STATE/runtime-probe.txt"
    found=""
    for candidate in docker podman; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        found="$candidate"
        WT_OUT="$tmp_out" with_timeout 5 "$candidate" info || true
        probe="$(cat "$tmp_out" 2>/dev/null || true)"
        rm -f "$tmp_out"
        case "$candidate" in
            docker)
                if printf '%s' "$probe" | grep -qi 'permission denied'; then
                    log "• 检测到 docker，但当前用户（${me}）没有权限访问它。"
                    log "  可以执行：sudo usermod -aG docker ${me}，然后重新登录；或改用 rootless podman（sudo apt install podman）。"
                else
                    log "• 检测到 docker，但 daemon 没有响应。"
                    log "  可以执行：sudo systemctl start docker。"
                fi ;;
            podman)
                if printf '%s' "$probe" | grep -qiE 'subuid|subgid|newuidmap|newgidmap|cannot find (uid|gid)'; then
                    log "• 检测到 podman，但 rootless 所需的用户映射没有配置好。"
                    log "  可以执行：sudo apt install uidmap && sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${me}，然后 podman system migrate，并重新登录。"
                else
                    log "• 检测到 podman，但 podman info 失败：$(printf '%s' "$probe" | head -n 1)"
                    log "  请先在终端里确认 podman info 能正常输出。"
                fi ;;
        esac
    done
    if [ -z "$found" ]; then
        log "• 没有检测到 docker 或 podman。Linux 版安装包不自带容器运行环境。"
        cmd="$(install_cmd_for podman)" || cmd=""
        if offer_sudo_install "$cmd"; then
            if EXTERNAL_CMD="$(detect_external_runtime)"; then
                return 0
            fi
            log "• podman 已安装，但 podman info 仍然失败，请先在终端里确认它能正常输出。"
        elif [ -n "$cmd" ]; then
            fail "没有可用的容器运行环境（docker 或 podman）。" "执行：${cmd}，然后重新运行安装命令。"
        else
            log "  请先用系统的包管理器安装 podman 或 docker。"
        fi
    fi
    fail "没有可用的容器运行环境（docker 或 podman）。" "按上面的提示装好并确认 docker info / podman info 能正常输出，然后重新运行本安装包即可续上。"
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
        rm -rf "$ROOT/app/.tmp-$MANYOYO_VERSION" "$ROOT/app/.old-$MANYOYO_VERSION"
        mv "$here/app" "$ROOT/app/.tmp-$MANYOYO_VERSION" || fail "无法写入 $ROOT/app。" "检查该目录的权限和磁盘空间。"
        printf '%s' "$MANIFEST_SHA" > "$ROOT/app/.tmp-$MANYOYO_VERSION/.installed"
        # 同版本重装：先挪开旧目录，新目录就位后再删；中途失败可以还原，不会留下 current 断链
        if [ -e "$app_dir" ]; then
            mv "$app_dir" "$ROOT/app/.old-$MANYOYO_VERSION" || fail "无法替换 ${app_dir}。" "检查该目录的权限，并关闭正在运行的 manyoyo 后重试。"
        fi
        if ! mv "$ROOT/app/.tmp-$MANYOYO_VERSION" "$app_dir"; then
            [ -e "$ROOT/app/.old-$MANYOYO_VERSION" ] && mv "$ROOT/app/.old-$MANYOYO_VERSION" "$app_dir"
            fail "无法写入 ${app_dir}。" "检查该目录的权限和磁盘空间。"
        fi
        rm -rf "$ROOT/app/.old-$MANYOYO_VERSION"
        clear_quarantine "$app_dir"
    fi
    ln -sfn "$MANYOYO_VERSION" "$ROOT/app/current"
}

install_podman() {
    if [ -f "$PODMAN_ROOT/.installed" ] && [ "$(cat "$PODMAN_ROOT/.installed")" = "$MANIFEST_SHA" ]; then
        log "• 私有 Podman 已安装，跳过"
        return 0
    fi
    log "▶ 安装私有 Podman（${MANYOYO_PODMAN_VERSION}）"
    mkdir -p "$PODMAN_ROOT"
    # 只替换程序目录；config/ 与 data/（machine、镜像存储）属于用户数据，重装不能动
    for sub in bin lib share; do
        rm -rf "${PODMAN_ROOT:?}/${sub:?}"
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
    # shellcheck disable=SC2016  # 下面是写进用户 shell 配置的字面文本，$PATH / $HOME 必须原样保留
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
    default_shell=/bin/zsh
    [ "${MANYOYO_OS:-macos}" = linux ] && default_shell=/bin/bash
    user_shell="$(basename "${MANYOYO_TEST_SHELL:-${SHELL:-$default_shell}}")"
    case "$user_shell" in
        zsh) add_path_block "$HOME_DIR/.zprofile"; add_path_block "$HOME_DIR/.zshrc" ;;
        bash)
            # bash 登录 shell 只读 .bash_profile / .bash_login / .profile 里第一个存在的；新建 .bash_profile 会让原有 .profile 失效
            login_file="$HOME_DIR/.bash_profile"
            [ -e "$login_file" ] || { [ -e "$HOME_DIR/.bash_login" ] && login_file="$HOME_DIR/.bash_login"; }
            [ -e "$login_file" ] || { [ -e "$HOME_DIR/.profile" ] && login_file="$HOME_DIR/.profile"; }
            add_path_block "$login_file"; add_path_block "$HOME_DIR/.bashrc" ;;
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

machine_listed() {
    podman_private machine list --format '{{.Name}}' 2>/dev/null | sed 's/\*$//' | grep -qx "$MANYOYO_MACHINE_NAME"
}

prepare_machine() {
    vm_file="$here/$MANYOYO_VM_FILE"
    # 虚拟机里可能已经有用户的容器：只要列表里有这个名字，就绝不重建、绝不删除
    if podman_private machine inspect "$MANYOYO_MACHINE_NAME" >/dev/null 2>&1 \
        || machine_listed; then
        log "• 虚拟机 $MANYOYO_MACHINE_NAME 已存在，跳过创建"
    else
        [ -f "$vm_file" ] || fail "安装包里没有虚拟机磁盘 ${MANYOYO_VM_FILE}。" "重新下载安装包并核对 SHA256。"
        log "▶ 创建虚拟机（约 10–20 秒）"
        if ! run podman_private machine init --image "$vm_file" "$MANYOYO_MACHINE_NAME"; then
            # 只清理这次 init 留下的半成品：init 之前它不在列表里，现在出现了，才是我们造成的
            if machine_listed; then
                run podman_private machine rm -f "$MANYOYO_MACHINE_NAME" || true
            fi
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
        # pid 必须确实是后台导入脚本（残留标记的 pid 可能已被别的进程复用）
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" 2>/dev/null | grep -q 'finish\.sh'; then
            log "• 镜像导入已在后台进行（pid ${pid}）"
            return 0
        fi
    fi
    archive="$IMPORT_DIR/$(basename "$MANYOYO_IMAGE_FILE")"
    if [ ! -f "$archive" ]; then
        [ -f "$here/$MANYOYO_IMAGE_FILE" ] || fail "安装包里没有镜像归档 ${MANYOYO_IMAGE_FILE}。" "重新下载安装包并核对 SHA256。"
        mv "$here/$MANYOYO_IMAGE_FILE" "$archive"
    fi
    cp "$here/install/finish-import.sh" "$IMPORT_DIR/finish.sh"
    log "▶ 在后台导入镜像（约 30–90 秒，期间可以先配置）"
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

# 记录这次安装带来的运行环境版本；manyoyo update 据此判断新版本的 Podman / 虚拟机磁盘有没有变化
write_installed_record() {
    podman_version=""
    vm_sha=""
    if [ "$MODE" = private ]; then
        podman_version="${MANYOYO_PODMAN_VERSION}"
        vm_sha="${MANYOYO_VM_SHA}"
    fi
    printf '{"version":"%s","kind":"%s","arch":"%s","imageVersion":"%s","podmanVersion":"%s","vmDiskSha256":"%s"}\n' \
        "$MANYOYO_VERSION" "$MANYOYO_KIND" "$MANYOYO_ARCH" "$MANYOYO_IMAGE_VERSION" "$podman_version" "$vm_sha" > "$STATE/installed.json"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    log "MANYOYO $MANYOYO_VERSION 安装（${MANYOYO_OS:-macos} / ${MANYOYO_ARCH}）"
    check_platform

    MODE=private
    EXTERNAL_CMD=""
    if [ "$MANYOYO_KIND" = full ]; then
        if [ -x "$PODMAN_ROOT/bin/podman" ]; then
            MODE=private
        elif EXTERNAL_CMD="$(detect_external_runtime)"; then
            MODE=external
            log "• 检测到可用的 ${EXTERNAL_CMD}，复用它，不安装内置 Podman 与虚拟机磁盘"
        fi
    else
        # 不带 Podman 的包只有 Linux 版：复用系统里已有的 docker / podman
        if EXTERNAL_CMD="$(detect_external_runtime)"; then
            MODE=external
            log "▶ 使用已有的 ${EXTERNAL_CMD}"
        else
            explain_no_runtime_linux
            MODE=external
            log "▶ 使用已有的 ${EXTERNAL_CMD}"
        fi
    fi
    if [ "${MANYOYO_OS:-macos}" = linux ] && [ "$MODE" = external ] && [ "$EXTERNAL_CMD" = podman ]; then
        ensure_rootless_network
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
    write_installed_record

    if [ "${MANYOYO_TEST_SKIP_MACHINE:-0}" != 1 ]; then
        if [ "$MODE" = private ]; then
            start_image_import private
        else
            start_image_import external "$EXTERNAL_CMD"
        fi
    fi

    log "✓ 安装完成：$ROOT"
    log "  新开一个终端后可直接输入 manyoyo；想在当前终端立刻使用，执行：exec \"\$SHELL\" -l"
    [ "${MANYOYO_FROM_BOOTSTRAP:-0}" = 1 ] || log "  安装包（.run 文件）现在可以删除。"

    if [ "$OPEN_AFTER" = 1 ]; then
        # shellcheck disable=SC2086
        # 下一步由 manyoyo 决定：有图形界面直接打开网页；无头时问怎么配置（没有终端则只安装）；顺带提示旧版残留
        "$ROOT/bin/manyoyo" --post-install $LAUNCH_FLAGS || log "• 没能继续配置，请新开终端后输入 manyoyo"
    fi
}

MANIFEST_SHA="$(sha256_of "$here/manifest.json")"
main
