FROM ubuntu:24.04

ARG TARGETARCH
ARG NODE_VERSION=24
ARG EXT=""

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

    # 安装 docker
    case ",$EXT," in *,all,*|*,docker,*)
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

RUN <<EOX
    # 安装 node.js
    case "$TARGETARCH" in
      amd64) ARCH_NODE="x64" ;;
      arm64) ARCH_NODE="arm64" ;;
      *)     ARCH_NODE="$TARGETARCH" ;;
    esac
    NVM_NODEJS_ORG_MIRROR=https://mirrors.tencent.com/nodejs-release/
    NODE_TAR=$(curl -sL ${NVM_NODEJS_ORG_MIRROR}/latest-v${NODE_VERSION}.x/SHASUMS256.txt | grep linux-${ARCH_NODE}.tar.gz | awk '{print $2}')
    curl -fsSL ${NVM_NODEJS_ORG_MIRROR}/latest-v${NODE_VERSION}.x/${NODE_TAR} | tar -xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude='LICENSE'
    npm config set registry=https://mirrors.tencent.com/npm/
    npm install -g npm

    # 安装 LSP服务（python、typescript）
    npm install -g pyright typescript-language-server typescript

    # 安装 Claude CLI
    npm install -g @anthropic-ai/claude-code
    echo '{"bypassPermissionsModeAccepted": true, "hasCompletedOnboarding": true, "env": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}}' > ~/.claude.json

    # 安装 Gemini CLI
    case ",$EXT," in *,all,*|*,gemini,*)
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
    case ",$EXT," in *,all,*|*,codex,*) npm install -g @openai/codex ;; esac

    # 安装 Copilot CLI
    case ",$EXT," in *,all,*|*,copilot,*)
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
    case ",$EXT," in *,all,*|*,opencode,*)
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

RUN <<EOX
    # 安装 java
    case ",$EXT," in *,all,*|*,java,*)
        apt-get update -y
        apt-get install -y --no-install-recommends openjdk-17-jdk maven

        # 安装 LSP服务（java）
        # 

        # 清理
        apt-get clean
        rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.cache ~/.npm ~/go/pkg/mod/cache
    ;; esac
EOX

RUN <<EOX
    # 安装 go
    case ",$EXT," in *,all,*|*,go,*)
        apt-get update -y
        apt-get install -y --no-install-recommends golang golang-src gcc
        go env -w GOPROXY=https://mirrors.tencentyun.com/go

        # 安装 LSP服务（go）
        # go install golang.org/x/tools/gopls@latest

        # 清理
        apt-get clean
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
