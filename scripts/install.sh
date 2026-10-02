#!/bin/sh
# MANYOYO 一键安装引导脚本（POSIX sh）：
#   curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
# 只负责：判断系统与芯片 → 查最新版本 → 下载安装包（.run）→ 校验 SHA256 → 启动安装包。
# 真正的安装逻辑在安装包解开后的 scripts/offline/install.sh（对应仓库里的 scripts/offline/install.sh），本脚本不新增任何权限，不执行 sudo。
#
# 参数（原样传给安装包）：--headless / --gui / --no-open
# 环境变量：
#   MANYOYO_VERSION=8.1.0           指定版本（默认最新 Release）
#   MANYOYO_KEEP_DOWNLOAD=1         安装成功后保留下载的安装包（默认删除）
#   MANYOYO_DOWNLOAD_BASE=<前缀>    替换 https://github.com/xcanwin/manyoyo/releases/download（下载慢或打不开时指向镜像）
#                                   校验清单与安装包都从这里取，所以镜像必须是你信任的
# 测试钩子（发布版默认不设置）：MANYOYO_LATEST_URL、MANYOYO_TEST_UNAME_S、MANYOYO_TEST_UNAME_M
set -eu

REPO_URL="https://github.com/xcanwin/manyoyo"
DOWNLOAD_BASE="${MANYOYO_DOWNLOAD_BASE:-${REPO_URL}/releases/download}"
LATEST_URL="${MANYOYO_LATEST_URL:-${REPO_URL}/releases/latest}"

say() { printf '%s\n' "$*"; }
fail() {
    printf '❌ %s\n' "$1" >&2
    [ -n "${2:-}" ] && printf '   %s\n' "$2" >&2
    exit 1
}

NPM_HINT="已有 Node.js 和 Docker / Podman 的话，可以改用: npm install -g @xcanwin/manyoyo"

# 整个脚本包在 main 里，最后一行才调用：curl | sh 中途断流时只会得到一个不完整的函数定义（语法错误），不会执行半截脚本
main() {

    command -v curl >/dev/null 2>&1 || fail "没有找到 curl。" "请先安装 curl 后重试。"
    # 校验工具要在命令替换之外检查（fail 在 $(...) 里只会退出子 shell）
    if command -v shasum >/dev/null 2>&1; then
        HASH_TOOL=shasum
    elif command -v sha256sum >/dev/null 2>&1; then
        HASH_TOOL=sha256sum
    else
        fail "没有找到 shasum 或 sha256sum，无法校验下载。"
    fi
    [ -n "${HOME:-}" ] || fail "没有设置 HOME，无法确定下载目录。"

    # 1. 系统与芯片
    raw_os="${MANYOYO_TEST_UNAME_S:-$(uname -s)}"
    raw_arch="${MANYOYO_TEST_UNAME_M:-$(uname -m)}"
    case "$raw_os" in
        Darwin) os_name=macos ;;
        Linux) os_name=linux ;;
        *) fail "不支持的系统: ${raw_os}。这个脚本只支持 macOS 和 Linux。" "$NPM_HINT" ;;
    esac
    case "$raw_arch" in
        arm64|aarch64) arch_name=arm64 ;;
        x86_64|amd64) arch_name=x64 ;;
        *) fail "不支持的 CPU 架构: ${raw_arch}。" "$NPM_HINT" ;;
    esac

    # 2. 版本：优先用 MANYOYO_VERSION，否则跟随 releases/latest 的跳转地址（不调 GitHub API，不带任何本机信息）
    version="${MANYOYO_VERSION:-}"
    version="${version#v}"
    if [ -z "$version" ]; then
        final_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$LATEST_URL")" || fail "无法查询最新版本。" "请检查网络，或用 MANYOYO_VERSION=<版本号> 指定版本后重试。"
        version="${final_url##*/}"
        version="${version#v}"
    fi
    printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "版本号格式不对: ${version}" "应形如 8.1.0。"
    tag="v${version}"
    say "MANYOYO ${version}（${os_name} / ${arch_name}）"

    # 3. 校验清单 → 选出安装包文件名（优先单文件，没有再找分卷 .run.001…）
    download_dir="${HOME}/.manyoyo/downloads"
    mkdir -p "$download_dir"
    chmod 700 "$download_dir" 2>/dev/null || true
    sums_file="${download_dir}/SHA256SUMS.${tag}.$$"
    trap 'rm -f "$sums_file"' EXIT
    curl -fsSL -o "$sums_file" "${DOWNLOAD_BASE}/${tag}/SHA256SUMS" || fail "下载校验清单失败（${DOWNLOAD_BASE}/${tag}/SHA256SUMS）。" "这个版本可能还没有发布安装包，或网络不通。"

    ver_re="$(printf '%s' "$version" | sed 's/\./\\./g')"
    base_re="manyoyo-${ver_re}-${os_name}-${arch_name}"
    files="$(grep -E "^[0-9a-f]{64}  ${base_re}\.run\$" "$sums_file" | sed 's/^[0-9a-f]*  //' || true)"
    if [ -z "$files" ]; then
        files="$(grep -E "^[0-9a-f]{64}  ${base_re}\.run\.[0-9]{3}\$" "$sums_file" | sed 's/^[0-9a-f]*  //' | sort || true)"
    fi
    [ -n "$files" ] || fail "${tag} 里没有适合 ${os_name}-${arch_name} 的安装包。" "$NPM_HINT"

    sha256_of() {
        if [ "$HASH_TOOL" = shasum ]; then
            shasum -a 256 "$1" | cut -d' ' -f1
        else
            sha256sum "$1" | cut -d' ' -f1
        fi
    }

    expected_of() {
        grep -E "^[0-9a-f]{64}  $(printf '%s' "$1" | sed 's/\./\\./g')\$" "$sums_file" | head -n 1 | cut -d' ' -f1
    }

    # 4. 下载（断点续传）并校验；已经下载完整的文件直接复用
    first_file=""
    for name in $files; do
        dest="${download_dir}/${name}"
        expected="$(expected_of "$name")"
        [ -n "$first_file" ] || first_file="$dest"
        if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$expected" ]; then
            say "已下载: ${name}"
            continue
        fi
        say "下载: ${name}"
        # 续传（-C -）。只有“服务器拒绝续传（HTTP 错误）”或“续传后校验不过”才删掉残留文件从头再下；
        # 网络中断等其他失败保留半截文件，下次重跑接着下
        curl_status=0
        curl -fL -C - --retry 3 -# -o "$dest" "${DOWNLOAD_BASE}/${tag}/${name}" || curl_status=$?
        if [ "$curl_status" -eq 0 ] && [ "$(sha256_of "$dest")" = "$expected" ]; then
            continue
        fi
        if [ "$curl_status" -ne 0 ] && [ "$curl_status" -ne 22 ]; then
            fail "下载 ${name} 中断（curl 退出码 ${curl_status}）。" "已下载的部分保留在 ${download_dir}，检查网络后重新运行会接着下载。"
        fi
        rm -f "$dest"
        curl -fL --retry 3 -# -o "$dest" "${DOWNLOAD_BASE}/${tag}/${name}" || fail "下载 ${name} 失败。" "检查网络后重新运行；下载慢可以用 MANYOYO_DOWNLOAD_BASE 指向镜像地址。"
        if [ "$(sha256_of "$dest")" != "$expected" ]; then
            rm -f "$dest"
            fail "${name} 校验失败，文件已删除。" "多半是下载中断或文件被改动，请重新运行脚本。"
        fi
    done

    # 5. 启动安装包。curl | sh 时标准输入是管道，安装器要交互就必须改读终端；没有终端（CI、ssh host '…'）时按无头安装
    has_tty() {
        [ -t 0 ] && return 0
        (exec </dev/tty) 2>/dev/null
    }
    force_flag=0
    for arg in "$@"; do
        case "$arg" in --headless|--gui) force_flag=1 ;; esac
    done

    status=0
    if [ -t 0 ]; then
        sh "$first_file" "$@" || status=$?
    elif has_tty; then
        sh "$first_file" "$@" </dev/tty || status=$?
    elif [ "$force_flag" = 1 ]; then
        sh "$first_file" "$@" </dev/null || status=$?
    else
        sh "$first_file" "$@" --headless </dev/null || status=$?
    fi

    if [ "$status" -ne 0 ]; then
        say "安装包没有正常结束（退出码 ${status}），已下载的文件保留在 ${download_dir}，修好问题后重新运行即可。"
        exit "$status"
    fi

    # 6. 安装成功：删除安装包（MANYOYO_KEEP_DOWNLOAD=1 保留，可拷到其他机器）
    if [ "${MANYOYO_KEEP_DOWNLOAD:-0}" = 1 ]; then
        say "安装包保留在 ${download_dir}"
    else
        for name in $files; do rm -f "${download_dir}/${name}"; done
    fi
}

main "$@"
