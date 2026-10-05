# ==============================================================================
# Stage 1: 缓存准备阶段 - 智能检测缓存或下载
# ==============================================================================
# 镜像源参数化（默认使用阿里云，可按需覆盖），两个阶段共享同一默认值
ARG APT_MIRROR=https://mirrors.aliyun.com
ARG NODEJS_MIRROR=https://mirrors.tencent.com/nodejs-release/

FROM ubuntu:24.04 AS cache-stage

ARG TARGETARCH
ARG TOOL="common"
ARG APT_MIRROR
ARG NODEJS_MIRROR

# 复制缓存目录（可能为空）
COPY ./docker/cache/ /cache/

RUN <<EOX
    # 确定架构
    set -eu
    case "$TARGETARCH" in
        amd64) ARCH_NODE="x64"; ARCH_GO="amd64" ;;
        arm64) ARCH_NODE="arm64"; ARCH_GO="arm64" ;;
        *)     ARCH_NODE="$TARGETARCH"; ARCH_GO="$TARGETARCH" ;;
    esac

    # 基础镜像不带 curl，仅在需要下载时按需安装
    ensure_curl() {
        if command -v curl > /dev/null 2>&1; then return 0; fi
        echo "安装 curl（缓存缺失，需联网下载）"
        if [ -n "${APT_MIRROR}" ]; then sed -i "s|http://[^/]*\.ubuntu\.com|${APT_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources; fi
        apt-get -o Acquire::https::Verify-Peer=false update -y
        apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends curl ca-certificates
    }

    # Node.js: 检测缓存，不存在则下载
    mkdir -p /opt/node
    if ls /cache/node/node-*-linux-${ARCH_NODE}.tar.gz 1> /dev/null 2>&1; then
        echo "使用 Node.js 缓存"
        # 缓存目录可能残留旧版本，取版本号最大的一个
        NODE_TAR=$(ls /cache/node/node-*-linux-${ARCH_NODE}.tar.gz | sort -V | tail -1)
        tar -xzf ${NODE_TAR} -C /opt/node --strip-components=1 --exclude='*.md' --exclude='LICENSE' --no-same-owner
    else
        echo "下载 Node.js"
        ensure_curl
        NVM_NODEJS_ORG_MIRROR=${NODEJS_MIRROR%/}
        NODE_TAR=$(curl -sL ${NVM_NODEJS_ORG_MIRROR}/latest-v24.x/SHASUMS256.txt | grep linux-${ARCH_NODE}.tar.gz | awk '{print $2}')
        curl -fsSL ${NVM_NODEJS_ORG_MIRROR}/latest-v24.x/${NODE_TAR} | tar -xz -C /opt/node --strip-components=1 --exclude='*.md' --exclude='LICENSE'
    fi

    # JDT LSP: 仅在 full/java 时准备缓存
    mkdir -p /opt/jdtls
    case ",$TOOL," in *,full,*|*,java,*)
        if [ -f /cache/jdtls/jdt-language-server-latest.tar.gz ]; then
            echo "使用 JDT LSP 缓存"
            tar -xzf /cache/jdtls/jdt-language-server-latest.tar.gz -C /opt/jdtls --no-same-owner
        else
            echo "下载 JDT LSP"
            ensure_curl
            curl -fsSL https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz | tar -xz -C /opt/jdtls
        fi
    ;; esac

    # gopls: 仅在 full/go 时准备缓存
    mkdir -p /opt/gopls
    case ",$TOOL," in *,full,*|*,go,*)
        if [ -f /cache/gopls/gopls-linux-${ARCH_GO} ]; then
            echo "使用 gopls 缓存"
            cp /cache/gopls/gopls-linux-${ARCH_GO} /opt/gopls/gopls
            chmod +x /opt/gopls/gopls
        else
            echo "下载 gopls (需要 go 环境)"
            # gopls 需要编译，这里跳过，在最终阶段处理
            touch /opt/gopls/.no-cache
        fi
    ;; esac
EOX

# ==============================================================================
# Stage 2: 最终镜像
# ==============================================================================
FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION=24
ARG TOOL="common"

# 镜像源参数化（APT_MIRROR 继承 FROM 之前的全局默认值）
ARG APT_MIRROR
ARG NPM_REGISTRY=https://mirrors.tencent.com/npm/
ARG PIP_INDEX_URL=https://mirrors.tencent.com/pypi/simple
# 轻量级文本解析依赖（可通过 --build-arg 覆盖）
ARG PY_TEXT_PIP_PACKAGES="PyYAML python-dotenv tomlkit pyjson5 jsonschema"
ARG PY_TEXT_EXTRA_PIP_PACKAGES=""
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_ROOT_USER_ACTION=ignore \
    NO_UPDATE_NOTIFIER=1 \
    DISPLAY=:99 \
    PLAYWRIGHT_MCP_CONFIG=/run/manyoyo-playwright/config.json

# 合并系统依赖与 Python 安装为单层，减少镜像体积
RUN <<EOX
    # 配置 APT 镜像源
    set -eu
    if [ -n "${APT_MIRROR}" ]; then sed -i "s|http://[^/]*\.ubuntu\.com|${APT_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources; fi
    ln -fs /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

    # 安装所有基础依赖
    # 网络与连接
    # 开发与构建
    # 系统管理
    # 通用工具
    # Python
    apt-get -o Acquire::https::Verify-Peer=false update -y
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends \
        ca-certificates openssl curl wget net-tools iputils-ping dnsutils socat ncat ssh \
        git gh g++ make sqlite3 \
        procps psmisc lsof supervisor \
        nano jq file tree ripgrep less bc xxd tar zip unzip gzip \
        python3.12 python3.12-dev python3.12-venv python3-pip

    # 更新 CA 证书
    update-ca-certificates

    # ssh 元包会带上 openssh-server 并在安装时生成主机私钥；公开镜像里不能带每个人都一样的固定私钥，
    # 删掉后用到 sshd 的人在容器里 ssh-keygen -A 自己生成
    rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub

    # 安装 podman（条件）
    case ",$TOOL," in *,full,*|*,podman,*)
        apt-get install -y --no-install-recommends podman
    ;; esac

    # 安装 docker（条件）
    case ",$TOOL," in *,full,*|*,docker,*)
        apt-get install -y --no-install-recommends docker.io
    ;; esac

    # 配置 python
    ln -sf /usr/bin/python3 /usr/bin/python
    ln -sf /usr/bin/pip3 /usr/bin/pip
    pip config set global.index-url "${PIP_INDEX_URL}"
    pip install --no-cache-dir --break-system-packages ${PY_TEXT_PIP_PACKAGES}
    if [ -n "${PY_TEXT_EXTRA_PIP_PACKAGES}" ]; then
        pip install --no-cache-dir --break-system-packages ${PY_TEXT_EXTRA_PIP_PACKAGES}
    fi

    # 清理
    apt-get clean
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
EOX

# 从 cache-stage 复制 Node.js（缓存或下载）
COPY --from=cache-stage /opt/node /usr/local
COPY ./package.json /tmp/manyoyo-package.json
COPY ./docker/res/ /tmp/docker-res/
ARG GIT_SSL_NO_VERIFY=false

RUN <<EOX
    # 配置 node.js
    set -eu
    npm config set registry=${NPM_REGISTRY}
    npm install -g npm
    npm config set allow-scripts=@anthropic-ai/claude-code,@openai/codex,@google/gemini-cli,opencode-ai,@playwright/cli,pyright,typescript-language-server,typescript --location=user

    export GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY

    # 安装 LSP服务（python、typescript）
    npm install -g pyright typescript-language-server typescript

    # 安装 Claude CLI
    # npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai
    npm install -g @anthropic-ai/claude-code
    mkdir -p ~/.claude/plugins/marketplaces/
    cp /tmp/docker-res/claude/claude.json ~/.claude.json
    cp /tmp/docker-res/claude/settings.json ~/.claude/settings.json
    cp /tmp/docker-res/claude/statusline.sh ~/.claude/statusline.sh
    chmod +x ~/.claude/statusline.sh
    claude plugin marketplace add https://github.com/anthropics/claude-plugins-official
    claude plugin install ralph-loop@claude-plugins-official
    claude plugin install typescript-lsp@claude-plugins-official
    claude plugin install pyright-lsp@claude-plugins-official
    case ",$TOOL," in *,full,*|*,go,*)
        claude plugin install gopls-lsp@claude-plugins-official
    ;; esac
    case ",$TOOL," in *,full,*|*,java,*)
        claude plugin install jdtls-lsp@claude-plugins-official
    ;; esac
    claude plugin marketplace add https://github.com/anthropics/skills
    claude plugin install document-skills@anthropic-agent-skills

    # 安装 Codex CLI
    npm install -g @openai/codex
    mkdir -p ~/.codex
    cp /tmp/docker-res/codex/config.toml ~/.codex/config.toml
    mkdir -p "$HOME/.codex/skills"
    git clone --depth 1 https://github.com/openai/skills.git /tmp/openai-skills
    cp -a /tmp/openai-skills/skills/.system "$HOME/.codex/skills/.system"
    rm -rf /tmp/openai-skills
    CODEX_INSTALLER="$HOME/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py"
    python3 "$CODEX_INSTALLER" --repo openai/skills --path \
        skills/.curated/security-best-practices \
        skills/.curated/security-threat-model
    python3 "$CODEX_INSTALLER" --repo anthropics/skills --path \
        skills/docx \
        skills/xlsx \
        skills/pptx \
        skills/pdf \
        skills/theme-factory \
        skills/frontend-design \
        skills/canvas-design \
        skills/doc-coauthoring \
        skills/internal-comms \
        skills/web-artifacts-builder \
        skills/webapp-testing

    # 安装 Gemini CLI
    case ",$TOOL," in *,full,*|*,gemini,*)
        npm install -g @google/gemini-cli
        mkdir -p ~/.gemini/ ~/.gemini/tmp/bin
        ln -s $(which rg) ~/.gemini/tmp/bin/rg
        cp /tmp/docker-res/gemini/settings.json ~/.gemini/settings.json
    ;; esac

    # 安装 OpenCode CLI
    case ",$TOOL," in *,full,*|*,opencode,*)
        npm install -g opencode-ai
        mkdir -p ~/.config/opencode/
        cp /tmp/docker-res/opencode/opencode.json ~/.config/opencode/opencode.json
    ;; esac

    # 安装 Playwright CLI skills、patchright-core 与 Google Chrome
    PLAYWRIGHT_CLI_INSTALL_DIR=/tmp/playwright-cli-install
    mkdir -p "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright"
    cd "$PLAYWRIGHT_CLI_INSTALL_DIR"
    pkg_field() { node -p "const pkg = require('/tmp/manyoyo-package.json'); const value = String(pkg.$1 || '').trim(); if (!value) { throw new Error('package.json.$1 is required'); } value"; }
    PLAYWRIGHT_CLI_VERSION=$(pkg_field playwrightCliVersion)
    PATCHRIGHT_CORE_VERSION=$(pkg_field patchrightCoreVersion)
    PATCHRIGHT_CORE_INTEGRITY=$(pkg_field patchrightCoreIntegrity)
    npm install -g "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}"
    # 把 @playwright/cli 自带的 playwright-core 换成 patchright-core（开源补丁版，可从源码逐字节复现）：
    # 官方版会在页面与 Worker 里启用 CDP Runtime 域，被检测站点识别；patchright 去掉了这一痕迹。
    # 两者必须同 minor（容器内 client 与宿主机 launchServer 要求 minor 完全一致），并以 package.json 里的 integrity 校验，不一致就中止构建
    CLI_DIR="$(npm root -g)/@playwright/cli"
    CLI_CORE_VERSION=$(node -p "require('$CLI_DIR/node_modules/playwright-core/package.json').version")
    [ "${CLI_CORE_VERSION%.*}" = "${PATCHRIGHT_CORE_VERSION%.*}" ] || { echo "playwright-core ${CLI_CORE_VERSION} 与 patchright-core ${PATCHRIGHT_CORE_VERSION} minor 不一致" >&2; exit 1; }
    npm pack "patchright-core@${PATCHRIGHT_CORE_VERSION}" --silent >/dev/null
    PATCHRIGHT_TARBALL="patchright-core-${PATCHRIGHT_CORE_VERSION}.tgz"
    [ "sha512-$(openssl dgst -sha512 -binary "$PATCHRIGHT_TARBALL" | openssl base64 -A)" = "$PATCHRIGHT_CORE_INTEGRITY" ] || { echo "patchright-core 完整性校验失败" >&2; exit 1; }
    for core in $(find "$CLI_DIR" -type d -name playwright-core -path '*/node_modules/playwright-core'); do
        rm -rf "$core"
        mkdir -p "$core"
        tar -xzf "$PATCHRIGHT_TARBALL" -C "$core" --strip-components=1
        # patchright 的客户端默认在隔离世界执行 evaluate（页面读不到 Agent 的变量，Agent 也读不到页面自己定义的全局变量），
        # 对 Agent 毫无用处；把客户端 evaluate / $eval 等 12 处默认值改回主世界（与官方 Playwright 行为一致）。
        # 在 integrity 校验之后做，次数对不上就中止（升级 patchright 时必须人工复核）；实测不影响 dabi / rebrowser 等检测
        ISOLATED_DEFAULTS=12
        [ "$(grep -o 'isolatedContext = true' "$core/lib/coreBundle.js" | wc -l)" = "$ISOLATED_DEFAULTS" ] || { echo "patchright-core 里 isolatedContext 默认值数量不是 ${ISOLATED_DEFAULTS}，请人工复核" >&2; exit 1; }
        sed -i 's/isolatedContext = true/isolatedContext = false/g' "$core/lib/coreBundle.js"
    done
    # 默认在 Xvfb 虚拟屏（配轻量窗口管理器）里跑有头浏览器，所以装 xvfb、fluxbox 与常见字体；x11vnc / noVNC 供 playwright vnc 模式使用
    apt-get update
    apt-get install -y --no-install-recommends xvfb fluxbox x11vnc novnc websockify fonts-noto-cjk fonts-noto-color-emoji fonts-liberation gpg
    # Google Chrome stable：官方 apt 源（amd64 / arm64 都有），固定签名密钥指纹，apt 再校验 Release 签名
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/google-linux-signing-key.pub
    [ "$(gpg --show-keys --with-colons /tmp/google-linux-signing-key.pub | awk -F: '/^fpr/{print $10; exit}')" = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796" ] || { echo "Google 签名密钥指纹不符" >&2; exit 1; }
    gpg --dearmor < /tmp/google-linux-signing-key.pub > /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt-get update
    apt-get install -y --no-install-recommends google-chrome-stable
    rm -f /etc/apt/sources.list.d/google-chrome.list /etc/cron.daily/google-chrome
    google-chrome --version
    playwright-cli install --skills
    PLAYWRIGHT_CLI_SKILL_SOURCE="$PLAYWRIGHT_CLI_INSTALL_DIR/.claude/skills/playwright-cli"
    for target in ~/.claude/skills/playwright-cli ~/.codex/skills/playwright-cli ~/.gemini/skills/playwright-cli; do
        mkdir -p "$target"
        cp -R "$PLAYWRIGHT_CLI_SKILL_SOURCE/." "$target/"
    done
    cd "$OLDPWD"
    rm -rf "$PLAYWRIGHT_CLI_INSTALL_DIR"

    # 清理
    npm cache clean --force
    rm -f /tmp/manyoyo-package.json
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/.cache/node-gyp ~/.claude/plugins/cache ~/go/pkg/mod/cache
    rm -f /var/log/dpkg.log /var/log/bootstrap.log /var/lib/dpkg/status-old /var/cache/debconf/templates.dat-old
EOX

# Playwright 默认配置（挂载宿主机目录时会被覆盖，路径固定）与按需启动 Xvfb 的 playwright-cli 包装
COPY ./docker/res/playwright/browser.json /run/manyoyo-playwright/config.json
COPY ./docker/res/playwright/stealth.init.js /run/manyoyo-playwright/stealth.init.js
COPY ./docker/res/playwright/env /run/manyoyo-playwright/env
COPY --chmod=755 ./docker/res/playwright/playwright-cli.sh /usr/local/sbin/playwright-cli
RUN ln -s playwright-cli /usr/local/sbin/playwright-mcp
# Chrome 154 起，不安全页面（http://host.containers.internal 这类宿主机别名）不能向 local 地址空间发请求（含同源 fetch），
# 会让 Agent 测试宿主机上的本地网页时 fetch 失败（旧的 Chromium 没有这个限制）；这条企业策略关闭该检查，只在容器内的 Chrome 生效
COPY ./docker/res/playwright/chrome-policy.json /etc/opt/chrome/policies/managed/local-network.json

# 从 cache-stage 复制 JDT LSP 到最终位置，避免中转层残留
COPY --from=cache-stage /opt/jdtls /root/.local/share/jdtls

RUN <<EOX
    # 安装 java
    set -eu
    case ",$TOOL," in *,full,*|*,java,*)
        apt-get update -y
        apt-get install -y --no-install-recommends openjdk-21-jdk maven

        # 配置 LSP服务（java）
        ln -sf ~/.local/share/jdtls/bin/jdtls /usr/local/bin/jdtls

        # 清理
        apt-get clean
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/go/pkg/mod/cache
    ;; esac
EOX

# 从 cache-stage 复制 gopls 到最终位置，避免中转层残留
COPY --from=cache-stage /opt/gopls /usr/local/share/manyoyo-gopls

RUN <<EOX
    # 安装 go
    set -eu
    case ",$TOOL," in *,full,*|*,go,*)
        apt-get update -y
        apt-get install -y --no-install-recommends golang gcc
        go env -w GOPROXY=https://mirrors.tencent.com/go

        # 安装 LSP服务（go）
        if [ -f /usr/local/share/manyoyo-gopls/gopls ] && [ ! -f /usr/local/share/manyoyo-gopls/.no-cache ]; then
            # 使用缓存
            chmod +x /usr/local/share/manyoyo-gopls/gopls
            ln -sf /usr/local/share/manyoyo-gopls/gopls /usr/local/bin/gopls
        else
            # 下载编译
            go install -trimpath golang.org/x/tools/gopls@latest
            ln -sf ~/go/bin/gopls /usr/local/bin/gopls
            rm -rf /usr/local/share/manyoyo-gopls
        fi
        # 清理
        apt-get clean
        go clean -modcache -cache
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/go/pkg/mod/cache
    ;; esac
EOX

# 配置 supervisor
COPY ./docker/res/supervisor/s.conf /etc/supervisor/conf.d/s.conf

RUN <<EOX
    # 清理
    set -eu
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/go/pkg/mod/cache
EOX

WORKDIR /tmp
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
