# ==============================================================================
# Stage 1: 缓存准备阶段 - 智能检测缓存或下载
# ==============================================================================
FROM ubuntu:24.04 AS cache-stage

ARG TARGETARCH
ARG TOOL="common"

# 复制缓存目录（可能为空）
COPY ./docker/cache/ /cache/

RUN <<EOX
    # 确定架构
    case "$TARGETARCH" in
        amd64) ARCH_NODE="x64"; ARCH_GO="amd64" ;;
        arm64) ARCH_NODE="arm64"; ARCH_GO="arm64" ;;
        *)     ARCH_NODE="$TARGETARCH"; ARCH_GO="$TARGETARCH" ;;
    esac

    # Node.js: 检测缓存，不存在则下载
    mkdir -p /opt/node
    if ls /cache/node/node-*-linux-${ARCH_NODE}.tar.gz 1> /dev/null 2>&1; then
        echo "使用 Node.js 缓存"
        NODE_TAR=$(ls /cache/node/node-*-linux-${ARCH_NODE}.tar.gz | head -1)
        tar -xzf ${NODE_TAR} -C /opt/node --strip-components=1 --exclude='*.md' --exclude='LICENSE' --no-same-owner
    else
        echo "下载 Node.js"
        NVM_NODEJS_ORG_MIRROR=https://mirrors.tencent.com/nodejs-release/
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
ARG TOOL="full"

# 镜像源参数化（默认使用阿里云，可按需覆盖）
ARG APT_MIRROR=https://mirrors.aliyun.com
ARG NPM_REGISTRY=https://mirrors.tencent.com/npm/
ARG PIP_INDEX_URL=https://mirrors.tencent.com/pypi/simple
# 轻量级文本解析依赖（可通过 --build-arg 覆盖）
ARG PY_TEXT_PIP_PACKAGES="PyYAML python-dotenv tomlkit pyjson5 jsonschema"
ARG PY_TEXT_EXTRA_PIP_PACKAGES=""
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# 合并系统依赖安装为单层，减少镜像体积
RUN <<EOX
    # 配置 APT 镜像源
    ln -fs /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
    sed -i "s|http://[^/]*\.ubuntu\.com|${APT_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources

    # 安装所有基础依赖
    # 网络与连接
    # 开发与构建
    # 系统管理
    # 通用工具
    apt-get -o Acquire::https::Verify-Peer=false update -y
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends \
        ca-certificates openssl curl wget net-tools iputils-ping dnsutils socat ncat ssh \
        git gh g++ make sqlite3 \
        procps psmisc lsof supervisor man-db \
        nano jq file tree ripgrep less bc xxd tar zip unzip gzip

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

    # 清理
    apt-get clean
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
EOX

RUN <<EOX
    # 安装 python
    apt-get update -y
    apt-get install -y --no-install-recommends python3.12 python3.12-dev python3.12-venv python3-pip
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
ARG GIT_SSL_NO_VERIFY=false

RUN <<EOX
    # 配置 node.js
    npm config set registry=${NPM_REGISTRY}

    export GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY

    # 安装 LSP服务（python、typescript）
    npm install -g pyright typescript-language-server typescript

    # 安装 Claude CLI
    npm install -g @anthropic-ai/claude-code
    mkdir -p ~/.claude/plugins/marketplaces/
    cat > ~/.claude.json <<EOF
{
    "bypassPermissionsModeAccepted": true,
    "hasCompletedOnboarding": true,
    "env": {
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_HIDE_ACCOUNT_INFO": "1",
        "DISABLE_AUTOUPDATER": "1"
    }
}
EOF
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
    cat > ~/.codex/config.toml <<EOF
check_for_update_on_startup = false

[analytics]
enabled = false
EOF
    mkdir -p "$HOME/.codex/skills"
    git clone --depth 1 https://github.com/openai/skills.git /tmp/openai-skills
    cp -a /tmp/openai-skills/skills/.system "$HOME/.codex/skills/.system"
    rm -rf /tmp/openai-skills
    CODEX_INSTALLER="$HOME/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py"
    python3 "$CODEX_INSTALLER" --repo openai/skills --path \
        skills/.curated/doc \
        skills/.curated/spreadsheet \
        skills/.curated/pdf \
        skills/.curated/security-best-practices \
        skills/.curated/security-threat-model
    python3 "$CODEX_INSTALLER" --repo anthropics/skills --path \
        skills/pptx \
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
        cat > ~/.gemini/settings.json <<EOF
{
    "privacy": {
        "usageStatisticsEnabled": false
    },
    "general": {
        "previewFeatures": true,
        "enableAutoUpdate": false,
        "enableAutoUpdateNotification": false
    },
    "ui": {
        "showLineNumbers": false
    },
    "security": {
        "auth": {
            "selectedType": "oauth-personal"
        }
    },
    "model": {
        "name": "gemini-3-pro-preview"
    }
}
EOF
    ;; esac

    # 安装 OpenCode CLI
    case ",$TOOL," in *,full,*|*,opencode,*)
        npm install -g opencode-ai
        mkdir -p ~/.config/opencode/
        cat > ~/.config/opencode/opencode.json <<EOF
{
    "\$schema": "https://opencode.ai/config.json",
    "autoupdate": false,
    "model": "Custom_Provider/{env:OPENAI_MODEL}",
    "provider": {
        "Custom_Provider": {
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": "{env:OPENAI_BASE_URL}",
                "apiKey": "{env:OPENAI_API_KEY}",
                "headers": {
                   "User-Agent": "opencode"
                }
            },
            "models": {
                "{env:OPENAI_MODEL}": {},
                "claude-sonnet-4-5-20250929": {},
                "gpt-5.2": {}
            }
        }
    }
}
EOF
    ;; esac

    # 清理
    npm cache clean --force
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
EOX

# 从 cache-stage 复制 JDT LSP（缓存或下载）
COPY --from=cache-stage /opt/jdtls /tmp/jdtls-cache

RUN <<EOX
    # 安装 java
    case ",$TOOL," in *,full,*|*,java,*)
        apt-get update -y
        apt-get install -y --no-install-recommends openjdk-21-jdk maven

        # 配置 LSP服务（java）
        mkdir -p ~/.local/share/
        cp -a /tmp/jdtls-cache ~/.local/share/jdtls
        ln -sf ~/.local/share/jdtls/bin/jdtls /usr/local/bin/jdtls

        # 清理
        apt-get clean
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
    ;; esac
    rm -rf /tmp/jdtls-cache
EOX

# 从 cache-stage 复制 gopls（缓存或下载）
COPY --from=cache-stage /opt/gopls /tmp/gopls-cache

RUN <<EOX
    # 安装 go
    case ",$TOOL," in *,full,*|*,go,*)
        apt-get update -y
        apt-get install -y --no-install-recommends golang golang-src gcc
        go env -w GOPROXY=https://mirrors.tencent.com/go

        # 安装 LSP服务（go）
        if [ -f /tmp/gopls-cache/gopls ] && [ ! -f /tmp/gopls-cache/.no-cache ]; then
            # 使用缓存
            cp /tmp/gopls-cache/gopls /usr/local/bin/gopls
            chmod +x /usr/local/bin/gopls
        else
            # 下载编译
            go install golang.org/x/tools/gopls@latest
            ln -sf ~/go/bin/gopls /usr/local/bin/gopls
        fi
        # 清理
        apt-get clean
        go clean -modcache -cache
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
    ;; esac
    rm -rf /tmp/gopls-cache
EOX

RUN <<EOX
    # 配置 supervisor
    cat > /etc/supervisor/conf.d/s.conf << EOF
[supervisord]
user=root
nodaemon=true
EOF
EOX

WORKDIR /tmp
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
