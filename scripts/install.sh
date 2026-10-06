#!/bin/sh
# MANYOYO 一键安装引导脚本（POSIX sh）：
#   curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
# 只负责：判断系统与芯片 → 查最新版本 → 下载安装包（.run）→ 校验 SHA256 → 启动安装包。
# 真正的安装逻辑在安装包解开后的 scripts/offline/install.sh（对应仓库里的 scripts/offline/install.sh），本脚本不新增任何权限，不执行 sudo。
#
# 参数（原样传给安装包）：--headless / --gui / --install-only（只安装，不启动服务、不打开浏览器、不问配置方式）
# 环境变量：
#   MANYOYO_VERSION=8.1.0           指定版本（默认最新 Release）
#   MANYOYO_KEEP_DOWNLOAD=1         安装成功后保留下载的安装包（默认删除）
#   MANYOYO_DOWNLOAD_BASE=<前缀>    只替换安装包（.run）的下载来源（下载慢时指向镜像）；
#                                   校验清单永远取自 GitHub 官方，所以镜像改不了内容，被改动的安装包会校验失败
#   代理：读 https_proxy 等环境变量；macOS 没设变量但开了系统代理时自动识别
# 测试钩子（发布版默认不设置）：MANYOYO_LATEST_URL、MANYOYO_SUMS_BASE、MANYOYO_TEST_UNAME_S、MANYOYO_TEST_UNAME_M、MANYOYO_TEST_SCUTIL
set -eu

REPO_URL="https://github.com/xcanwin/manyoyo"
DOWNLOAD_BASE="${MANYOYO_DOWNLOAD_BASE:-${REPO_URL}/releases/download}"
LATEST_URL="${MANYOYO_LATEST_URL:-${REPO_URL}/releases/latest}"
# 校验清单固定取官方地址（MANYOYO_SUMS_BASE 仅测试钩子，发布版默认不设置）
SUMS_BASE="${MANYOYO_SUMS_BASE:-${REPO_URL}/releases/download}"
RELEASES_URL="${REPO_URL}/releases"

say() { printf '%s\n' "$*"; }
fail() {
    printf '❌ %s\n' "$1" >&2
    [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/   /' >&2
    exit 1
}

# 打印代理地址时去掉账号密码
proxy_display() {
    printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#'
}

# 网络失败时的“代理”一句：已设代理就请确认可用，没设就教怎么设
proxy_hint() {
    if [ -n "${PROXY_SHOWN:-}" ]; then
        printf '当前代理: %s，请确认代理可用' "$PROXY_SHOWN"
    else
        printf '有代理的话先在终端设置: export https_proxy=http://127.0.0.1:7890'
    fi
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

    # 代理：curl 自己读 https_proxy；macOS 没设变量但开了系统代理时读系统设置并导出（安装包里的 Node 与后续步骤也用得上）
    PROXY_SHOWN=""
    current_proxy="${https_proxy:-${HTTPS_PROXY:-${all_proxy:-${ALL_PROXY:-}}}}"
    if [ -n "$current_proxy" ]; then
        PROXY_SHOWN="$(proxy_display "$current_proxy")"
        say "使用代理: ${PROXY_SHOWN}"
    elif [ "$os_name" = macos ]; then
        scutil_cmd="${MANYOYO_TEST_SCUTIL:-/usr/sbin/scutil}"
        scutil_out="$("$scutil_cmd" --proxy 2>/dev/null || true)"
        for prefix in HTTPS HTTP; do
            sys_on="$(printf '%s\n' "$scutil_out" | awk -v k="${prefix}Enable" '$1 == k { print $3 }')"
            sys_host="$(printf '%s\n' "$scutil_out" | awk -v k="${prefix}Proxy" '$1 == k { print $3 }')"
            sys_port="$(printf '%s\n' "$scutil_out" | awk -v k="${prefix}Port" '$1 == k { print $3 }')"
            if [ "$sys_on" = 1 ] && [ -n "$sys_host" ] && [ -n "$sys_port" ]; then
                https_proxy="http://${sys_host}:${sys_port}"
                http_proxy="$https_proxy"
                export https_proxy http_proxy
                PROXY_SHOWN="$https_proxy"
                say "使用系统代理: ${PROXY_SHOWN}"
                break
            fi
        done
    fi

    # 2. 版本：优先用 MANYOYO_VERSION，否则跟随 releases/latest 的跳转地址（不调 GitHub API，不带任何本机信息）
    version="${MANYOYO_VERSION:-}"
    version="${version#v}"
    if [ -z "$version" ]; then
        final_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$LATEST_URL")" || fail "无法查询最新版本。" "地址: ${LATEST_URL}
$(proxy_hint)
也可以用 MANYOYO_VERSION=<版本号> 指定版本后重试，版本号见 ${RELEASES_URL}"
        version="${final_url##*/}"
        version="${version#v}"
    fi
    printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "版本号格式不对: ${version}" "应形如 8.1.0。"
    tag="v${version}"
    say "MANYOYO ${version}（${os_name} / ${arch_name}）"

    # 3. 校验清单 → 选出安装包文件名（优先单文件，没有再找分卷 .run.001…）
    # 进度条只在终端里显示；日志 / CI 里（stderr 不是终端）会刷出几十 KB 的进度行
    if [ -t 2 ]; then PROGRESS=-#; else PROGRESS=-sS; fi
    download_dir="${HOME}/.manyoyo/downloads"
    mkdir -p "$download_dir"
    chmod 700 "$download_dir" 2>/dev/null || true
    sums_file="${download_dir}/SHA256SUMS.${tag}.$$"
    trap 'rm -f "$sums_file"' EXIT
    if [ -n "${MANYOYO_DOWNLOAD_BASE:-}" ]; then
        say "安装包来源: ${DOWNLOAD_BASE}（校验清单仍取自 GitHub 官方）"
    fi
    say "下载校验清单: ${SUMS_BASE}/${tag}/SHA256SUMS"
    curl -fsSL -o "$sums_file" "${SUMS_BASE}/${tag}/SHA256SUMS" || fail "下载校验清单失败。" "地址: ${SUMS_BASE}/${tag}/SHA256SUMS
这个版本可能还没有发布安装包，或网络不通。
$(proxy_hint)
也可以用浏览器从 ${RELEASES_URL}/tag/${tag} 下载 manyoyo-${version}-${os_name}-${arch_name}.run，然后执行: sh <下载的文件>"

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

    # 下载失败时的手动办法：列出完整地址（分卷要全部下载到同一目录，对第一卷执行 sh）
    manual_hint() {
        printf '%s\n' "$(proxy_hint)"
        printf '也可以用浏览器下载下面的文件（放在同一目录），然后执行: sh <第一个文件>\n'
        for m in $files; do printf '%s\n' "${DOWNLOAD_BASE}/${tag}/${m}"; done
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
        say "下载: ${DOWNLOAD_BASE}/${tag}/${name}"
        # 续传（-C -）。只有“服务器拒绝续传（HTTP 错误）”或“续传后校验不过”才删掉残留文件从头再下；
        # 网络中断等其他失败保留半截文件，下次重跑接着下
        curl_status=0
        # shellcheck disable=SC2086  # 进度条参数是单个固定选项
        curl -fL -C - --retry 3 $PROGRESS -o "$dest" "${DOWNLOAD_BASE}/${tag}/${name}" || curl_status=$?
        if [ "$curl_status" -eq 0 ] && [ "$(sha256_of "$dest")" = "$expected" ]; then
            continue
        fi
        if [ "$curl_status" -ne 0 ] && [ "$curl_status" -ne 22 ]; then
            fail "下载 ${name} 中断（curl 退出码 ${curl_status}）。" "地址: ${DOWNLOAD_BASE}/${tag}/${name}
已下载的部分保留在 ${download_dir}，检查网络后重新运行会接着下载。
$(manual_hint)"
        fi
        rm -f "$dest"
        # shellcheck disable=SC2086
        curl -fL --retry 3 $PROGRESS -o "$dest" "${DOWNLOAD_BASE}/${tag}/${name}" || fail "下载 ${name} 失败。" "地址: ${DOWNLOAD_BASE}/${tag}/${name}
$(manual_hint)"
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

    # 告诉安装包它是被引导脚本下载的（引导脚本会自己删除安装包，安装包不必再提示“可以删除”）
    export MANYOYO_FROM_BOOTSTRAP=1
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
