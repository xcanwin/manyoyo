# ==============================================================================
# Stage 1: 缓存准备阶段 - 智能检测缓存或下载
# ==============================================================================
FROM ubuntu:24.04 AS cache-stage

ARG TARGETARCH

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

    # JDT LSP: 检测缓存，不存在则下载
    mkdir -p /opt/jdtls
    if [ -f /cache/jdtls/jdt-language-server-latest.tar.gz ]; then
        echo "使用 JDT LSP 缓存"
        tar -xzf /cache/jdtls/jdt-language-server-latest.tar.gz -C /opt/jdtls --no-same-owner
    else
        echo "下载 JDT LSP"
        curl -fsSL https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz | tar -xz -C /opt/jdtls
    fi

    # gopls: 检测缓存，不存在则下载
    mkdir -p /opt/gopls
    if [ -f /cache/gopls/gopls-linux-${ARCH_GO} ]; then
        echo "使用 gopls 缓存"
        cp /cache/gopls/gopls-linux-${ARCH_GO} /opt/gopls/gopls
        chmod +x /opt/gopls/gopls
    else
        echo "下载 gopls (需要 go 环境)"
        # gopls 需要编译，这里跳过，在最终阶段处理
        touch /opt/gopls/.no-cache
    fi
EOX

# ==============================================================================
# Stage 2: 最终镜像
# ==============================================================================
FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION=24
ARG TOOL="full"

RUN <<EOX
    # 部署 system

    # 修复CA证书
    sed -i 's|http://[^/]*\.ubuntu\.com|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources
    apt-get -o Acquire::https::Verify-Peer=false update -y
    apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates openssl
    update-ca-certificates

    # 安装基本依赖
    apt-get update -y
    apt-get install -y --no-install-recommends --reinstall ca-certificates openssl
    update-ca-certificates
    apt-get install -y --no-install-recommends curl wget net-tools iputils-ping git lsof socat ncat dnsutils \
                    nano jq file tree ripgrep less bc xxd \
                    tar zip unzip gzip make sqlite3 \
                    supervisor

    # 安装 podman
    case ",$TOOL," in *,full,*|*,podman,*)
        apt-get install -y --no-install-recommends podman
    ;; esac

    # 安装 docker
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
    pip config set global.index-url "https://mirrors.tencent.com/pypi/simple"

    # 清理
    apt-get clean
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
EOX

# 从 cache-stage 复制 Node.js（缓存或下载）
COPY --from=cache-stage /opt/node /usr/local
ARG GIT_SSL_NO_VERIFY=false

RUN <<EOX
    # 配置 node.js
    npm config set registry=https://mirrors.tencent.com/npm/
    npm install -g npm

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
    GIT_SSL_NO_VERIFY=$GIT_SSL_NO_VERIFY claude plugin marketplace add anthropics/claude-plugins-official
    claude plugin install ralph-loop@claude-plugins-official
    claude plugin install typescript-lsp@claude-plugins-official
    claude plugin install pyright-lsp@claude-plugins-official
    claude plugin install gopls-lsp@claude-plugins-official
    claude plugin install jdtls-lsp@claude-plugins-official

    # 安装 Gemini CLI
    case ",$TOOL," in *,full,*|*,gemini,*)
        npm install -g @google/gemini-cli
        mkdir -p ~/.gemini/
        cat > ~/.gemini/settings.json <<EOF
{
  "privacy": {
    "usageStatisticsEnabled": false
  },
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  },
  "general": {
    "previewFeatures": true,
    "disableAutoUpdate": true,
    "disableUpdateNag": true
  },
  "model": {
    "name": "gemini-3-pro-preview"
  }
}
EOF
    ;; esac

    # 安装 Codex CLI
    case ",$TOOL," in *,full,*|*,codex,*)
        npm install -g @openai/codex
    ;; esac

    # 安装 Copilot CLI
    case ",$TOOL," in *,full,*|*,copilot,*)
        npm install -g @github/copilot
        mkdir -p ~/.copilot/
        cat > ~/.copilot/config.json <<EOF
{
  "banner": "never",
  "model": "gemini-3-pro-preview",
  "render_markdown": true,
  "screen_reader": false,
  "theme": "auto"
}
EOF
    ;; esac

    # 安装 OpenCode CLI
    case ",$TOOL," in *,full,*|*,opencode,*)
        npm install -g opencode-ai
        mkdir -p ~/.config/opencode/
        cat > ~/.config/opencode/opencode.json <<EOF
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "permission": "allow",
  "model": "myprovider/{env:ANTHROPIC_MODEL}",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "{env:ANTHROPIC_BASE_URL}",
        "apiKey": "{env:ANTHROPIC_AUTH_TOKEN}",
        "headers": {
          "User-Agent": "opencode-cli"
        }
      },
      "models": {
        "{env:ANTHROPIC_MODEL}": {},
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
COPY --from=cache-stage /opt/jdtls /root/.local/share/jdtls

RUN <<EOX
    # 安装 java
    case ",$TOOL," in *,full,*|*,java,*)
        apt-get update -y
        apt-get install -y --no-install-recommends openjdk-21-jdk maven

        # 配置 LSP服务（java）
        ln -sf ~/.local/share/jdtls/bin/jdtls /usr/local/bin/jdtls

        # 清理
        apt-get clean
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
    ;; esac
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
        rm -rf /tmp/gopls-cache

        # 清理
        apt-get clean
        go clean -modcache -cache
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
    ;; esac
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
