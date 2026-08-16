# ==============================================================================
# Stage 1: 缓存准备阶段 - 智能检测缓存或下载
# ==============================================================================
FROM ubuntu:24.04 AS cache-stage

ARG TARGETARCH
ARG TOOL="common"
ARG NODE_MIRROR=https://nodejs.org/dist
ARG NODE_VERSION=24.19.0
ARG NODE_SHA256_X64=f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4
ARG NODE_SHA256_ARM64=d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f
ARG JDTLS_URL=https://download.eclipse.org/jdtls/milestones/1.58.0/jdt-language-server-1.58.0-202604151538.tar.gz
ARG JDTLS_FILE=jdt-language-server-1.58.0-202604151538.tar.gz
ARG JDTLS_SHA256=2a5bbe55ec91b4325392050dc422cead3220a2459b3766be35e1fff45b4a50d9

# 复制缓存目录（可能为空）
COPY ./docker/cache/ /cache/

RUN <<EOX
    # 确定架构
    set -eu
    case "$TARGETARCH" in
        amd64) ARCH_NODE="x64"; ARCH_GO="amd64"; NODE_SHA256="$NODE_SHA256_X64" ;;
        arm64) ARCH_NODE="arm64"; ARCH_GO="arm64"; NODE_SHA256="$NODE_SHA256_ARM64" ;;
        *)     ARCH_NODE="$TARGETARCH"; ARCH_GO="$TARGETARCH"; NODE_SHA256="" ;;
    esac

    # Node.js: 检测缓存，不存在则下载
    mkdir -p /opt/node
    NODE_FILE="node-v${NODE_VERSION}-linux-${ARCH_NODE}.tar.gz"
    if [ -f "/cache/node/${NODE_FILE}" ] && [ -n "$NODE_SHA256" ] && echo "${NODE_SHA256}  /cache/node/${NODE_FILE}" | sha256sum -c -; then
        echo "使用 Node.js 缓存"
        tar -xzf "/cache/node/${NODE_FILE}" -C /opt/node --strip-components=1 --exclude='*.md' --exclude='LICENSE' --no-same-owner
    else
        echo "下载 Node.js"
        test -n "$NODE_SHA256"
        curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/${NODE_FILE}" -o "/tmp/${NODE_FILE}"
        echo "${NODE_SHA256}  /tmp/${NODE_FILE}" | sha256sum -c -
        tar -xzf "/tmp/${NODE_FILE}" -C /opt/node --strip-components=1 --exclude='*.md' --exclude='LICENSE'
    fi

    # JDT LSP: 仅在 full/java 时准备缓存
    mkdir -p /opt/jdtls
    case ",$TOOL," in *,full,*|*,java,*)
        if [ -f "/cache/jdtls/${JDTLS_FILE}" ] && echo "${JDTLS_SHA256}  /cache/jdtls/${JDTLS_FILE}" | sha256sum -c -; then
            echo "使用 JDT LSP 缓存"
            tar -xzf "/cache/jdtls/${JDTLS_FILE}" -C /opt/jdtls --no-same-owner
        else
            echo "下载 JDT LSP"
            curl -fsSL "$JDTLS_URL" -o /tmp/jdtls.tar.gz
            echo "${JDTLS_SHA256}  /tmp/jdtls.tar.gz" | sha256sum -c -
            tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls
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
ARG TOOL="common"

# 镜像源参数化（默认使用公共源，可按需覆盖）
ARG APT_MIRROR=https://archive.ubuntu.com
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG GOPROXY=https://proxy.golang.org
ARG GOPLS_VERSION=v0.23.0
ARG NPM_VERSION=12.0.2
ARG PYRIGHT_VERSION=1.1.413
ARG TYPESCRIPT_LANGUAGE_SERVER_VERSION=5.3.0
ARG TYPESCRIPT_VERSION=5.9.3
ARG CLAUDE_CODE_VERSION=2.1.233
ARG CODEX_VERSION=0.147.0
ARG GEMINI_VERSION=0.55.1
ARG OPENCODE_VERSION=1.18.18
# 轻量级文本解析依赖（可通过 --build-arg 覆盖）
ARG PY_TEXT_PIP_PACKAGES="PyYAML python-dotenv tomlkit pyjson5 jsonschema"
ARG PY_TEXT_EXTRA_PIP_PACKAGES=""
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_ROOT_USER_ACTION=ignore \
    PLAYWRIGHT_MCP_CONFIG=/app/config/cli-cont-headless.json

# 合并系统依赖与 Python 安装为单层，减少镜像体积
RUN <<EOX
    # 配置 APT 镜像源
    set -eu
    sed -i "s|http://[^/]*\.ubuntu\.com|${APT_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources
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
COPY ./docker/res/playwright/cli-cont-headless.init.js /app/config/cli-cont-headless.init.js
COPY ./docker/res/playwright/cli-cont-headless.json /app/config/cli-cont-headless.json
COPY ./docker/res/ /tmp/docker-res/
ARG GIT_SSL_NO_VERIFY=false

RUN <<EOX
    # 配置 node.js
    set -eu
    npm config set registry=${NPM_REGISTRY}
    npm install -g "npm@${NPM_VERSION}"
    npm config set allow-scripts=@anthropic-ai/claude-code,@openai/codex,@google/gemini-cli,opencode-ai,@playwright/cli,pyright,typescript-language-server,typescript --location=user

    export GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY

    # 安装 LSP服务（python、typescript）
    npm install -g "pyright@${PYRIGHT_VERSION}" "typescript-language-server@${TYPESCRIPT_LANGUAGE_SERVER_VERSION}" "typescript@${TYPESCRIPT_VERSION}"

    # 安装 Claude CLI
    # npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
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
    npm install -g "@openai/codex@${CODEX_VERSION}"
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
        npm install -g "@google/gemini-cli@${GEMINI_VERSION}"
        mkdir -p ~/.gemini/ ~/.gemini/tmp/bin
        ln -s $(which rg) ~/.gemini/tmp/bin/rg
        cp /tmp/docker-res/gemini/settings.json ~/.gemini/settings.json
    ;; esac

    # 安装 OpenCode CLI
    case ",$TOOL," in *,full,*|*,opencode,*)
        npm install -g "opencode-ai@${OPENCODE_VERSION}"
        mkdir -p ~/.config/opencode/
        cp /tmp/docker-res/opencode/opencode.json ~/.config/opencode/opencode.json
    ;; esac

    # 安装 Playwright CLI skills（不在镜像构建阶段下载浏览器）
    PLAYWRIGHT_CLI_INSTALL_DIR=/tmp/playwright-cli-install
    mkdir -p "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright"
    cd "$PLAYWRIGHT_CLI_INSTALL_DIR"
    PLAYWRIGHT_CLI_VERSION=$(node -p "const pkg = require('/tmp/manyoyo-package.json'); const value = String(pkg.playwrightCliVersion || '').trim(); if (!value) { throw new Error('package.json.playwrightCliVersion is required'); } value")
    npm install -g "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}"
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
        go env -w GOPROXY=${GOPROXY}

        # 安装 LSP服务（go）
        if [ -f /usr/local/share/manyoyo-gopls/gopls ] && [ ! -f /usr/local/share/manyoyo-gopls/.no-cache ]; then
            # 使用缓存
            chmod +x /usr/local/share/manyoyo-gopls/gopls
            ln -sf /usr/local/share/manyoyo-gopls/gopls /usr/local/bin/gopls
        else
            # 下载编译
            go install golang.org/x/tools/gopls@${GOPLS_VERSION}
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
