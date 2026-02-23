---
title: Installation Guide | MANYOYO
description: Complete MANYOYO installation guide covering Node.js and Docker/Podman prerequisites, global install, image build options, and common setup issues.
---

# Installation Guide

This page provides a detailed installation guide for MANYOYO, including prerequisites, installation steps, and image building.

## System Requirements

### Required

- **Node.js** >= 22.0.0
- **Docker** or **Podman** (Podman recommended)

### Recommended

- Disk Space: At least 10GB available (for images and cache)
- Memory: At least 4GB RAM
- Network: Stable network connection (required for downloading dependencies on first build)

## Verify Prerequisites

Before installing MANYOYO, confirm that required software is installed:

```bash
# Check Node.js version (requires >= 22.0.0)
node --version

# Check npm version
npm --version

# Check Docker or Podman
docker --version   # or
podman --version
```

If not installed, please install these software first:

### Install Node.js

**macOS/Linux**:
```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22

# Or using system package manager
# macOS
brew install node@22

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows (Native)**:
- Download installer from [Node.js official website](https://nodejs.org/) (best for PowerShell/native Windows workflow)

**Windows (WSL2)**:
- In WSL2, use the Linux-style installation flow, preferably `nvm` (best for Bash/Linux workflow)

```bash
# Run inside WSL terminal
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22
```

### Install Podman (Recommended)

**macOS**:
```bash
brew install podman

# Initialize Podman machine
podman machine init
podman machine start
```

**Linux**:
```bash
# Fedora/RHEL/CentOS
sudo dnf install podman

# Ubuntu/Debian
sudo apt-get update
sudo apt-get install podman

# Arch Linux
sudo pacman -S podman
```

**Windows**:
- Download installer from [Podman official website](https://podman.io/docs/installation)

### Install Docker (Optional)

If choosing to use Docker instead of Podman:

**macOS/Windows**:
- Download [Docker Desktop](https://www.docker.com/products/docker-desktop/)

**Linux**:
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

## Install MANYOYO

### Global Installation (Recommended)

Install MANYOYO globally using npm:

```bash
npm install -g @xcanwin/manyoyo
```

### Non-root Global npm Install (macOS/Linux/WSL)

If `npm install -g xxx` fails with `EACCES` / `permission denied`, use a user-owned global prefix instead of `sudo`:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

Notes:
- This permission issue is common on macOS/Linux/WSL when Node.js uses a system-owned prefix (for example `/usr/local`)
- Native Windows environment does not use `sudo`
- If you use zsh, append PATH in `~/.zprofile` or `~/.zshrc`

After installation, verify:

```bash
# Check version
manyoyo -V

# View help information
manyoyo -h
```

### Local Development Installation

If you need to install from source (for development or testing):

```bash
# Clone repository
git clone https://github.com/xcanwin/manyoyo.git
cd manyoyo

# Install dependencies
npm install

# Global link (development mode)
npm install -g .

# Or use npm link
npm link
```

### Update MANYOYO

Update to the latest version:

```bash
npm update -g @xcanwin/manyoyo
```

Check for updates:

```bash
npm outdated -g @xcanwin/manyoyo
```

## Pull Base Image (Podman Users)

::: warning Podman Users Only
Docker users can skip this step. Docker will automatically pull the base image.
:::

Podman users need to manually pull the Ubuntu base image:

```bash
podman pull ubuntu:24.04
```

Verify the image:

```bash
podman images | grep ubuntu
```

## Build Sandbox Image

MANYOYO uses custom container images that include pre-installed AI CLI tools and development environments.

### Recommended Method: Build with manyoyo

```bash
# Build recommended version (common)
manyoyo build --iv 1.8.0-common

# Verify after build
docker images | grep manyoyo  # or podman images
```

**Advantages**:
- Automatically uses cache to accelerate builds
- First build: Automatically downloads Node.js, JDT LSP, gopls, etc. to `docker/cache/`
- Rebuilding within 2 days: Directly uses local cache, approximately **5x faster**
- After cache expires: Automatically re-downloads latest versions

### Build Options

#### Full Version (full)

Includes all supported AI CLI tools and development environments:

```bash
manyoyo build --iv 1.8.0-full
# Or explicitly specify build args
manyoyo build --iv 1.8.0-full --iba TOOL=full
```

**Included Tools**:
- Claude Code
- Codex
- Gemini
- OpenCode
- Python, Node.js, Go, Java development environments
- Common LSP servers

**Image Size**: Approximately 3-5 GB

#### Minimal Version (common)

Includes only commonly used components:

```bash
manyoyo build --iba TOOL=common
```

**Included Tools**:
- Claude Code
- Codex
- Python, Node.js basic environments
- Common CLI tools

**Image Size**: Approximately 1-2 GB

**Use Cases**:
- Limited disk space
- Using Claude Code / Codex
- Quick testing

#### Custom Version

Select specific tool combinations:

```bash
# Install only specified tools
manyoyo build --iba TOOL=go,codex,java,gemini

# Component descriptions:
# - python: Python environment
# - nodejs: Node.js environment
# - claude: Claude Code
# - codex: Codex
# - gemini: Gemini
# - opencode: OpenCode
# - go: Go environment and gopls
# - java: Java environment and JDT LSP
```

#### Custom Image Name and Version

```bash
# Custom image name and version
manyoyo build --in myimage --iv 1.8.0-common
# Generates image: myimage:1.8.0-common

# Specify full image name
manyoyo build --in localhost/myuser/sandbox --iv 1.0.0-common
# Generates image: localhost/myuser/sandbox:1.0.0-common
```

#### Special Build Parameters

```bash
# Skip Git SSL verification (development environments only)
manyoyo build --iba GIT_SSL_NO_VERIFY=true

# Disable China mirrors (users outside China)
manyoyo build --iba NODE_MIRROR= --iba NPM_REGISTRY=

# Use custom mirror sources
manyoyo build --iba NODE_MIRROR=https://custom-mirror.com
```

### Manual Build (Not Recommended)

If you need more control, you can manually use Docker/Podman commands:

```bash
iv=1.8.0
podman build \
    -t localhost/xcanwin/manyoyo:$iv-full \
    -f docker/manyoyo.Dockerfile . \
    --build-arg TOOL=full \
    --no-cache
```

::: warning Manual Build Not Recommended
Manual builds will not use MANYOYO's cache mechanism, resulting in significantly longer build times.
:::

## Cache Mechanism

MANYOYO automatically manages build cache to accelerate repeated builds:

### Cache Directory

```bash
docker/cache/
├── node-v22.x.x-linux-x64.tar.xz
├── gopls-v0.x.x-linux-amd64.tar.gz
├── jdt-language-server-x.x.x.tar.gz
└── ...
```

### Cache Validity Period

- **Validity**: 2 days
- **First Build**: Downloads all dependencies to cache directory
- **Rebuilding within 2 days**: Directly uses cache, approximately **5x faster**
- **After Cache Expires**: Automatically re-downloads latest versions

### Manual Cache Management

```bash
# View cache
ls -lh docker/cache/

# Clean cache (not recommended, will slow down next build)
rm -rf docker/cache/

# Manually update cache timestamps
touch docker/cache/*
```

## Verify Installation

After completing installation, perform the following verifications:

### 1. Verify MANYOYO Installation

```bash
# Check version
manyoyo -V

# View help
manyoyo -h
```

### 2. Verify Image

```bash
# List images
docker images | grep manyoyo  # or podman images

# Should see something like:
# localhost/xcanwin/manyoyo  1.8.0-common  xxx  xxx  xxGB
```

### 3. Initialize Agent Config (Recommended)

```bash
# Migrate existing claude/codex/gemini/opencode setup from host
manyoyo init all
```

### 4. Create Test Container

```bash
# Create and run test container
manyoyo run -n test-container -x echo "MANYOYO works!"

# View container
manyoyo ls

# Delete test container
manyoyo rm test-container
```

### 5. Test AI CLI Tools

```bash
# Use initialized run config (recommended)
manyoyo run -r claude

# Or only check CLI version
manyoyo run -n test -x claude --version

# Test Python
manyoyo run -n test -x python3 --version

# Test Node.js
manyoyo run -n test -x node --version
```

## Troubleshooting

Installation issues are centralized in:
- [Troubleshooting Guide](../troubleshooting/README.md)
- [Build Issues Guide](../troubleshooting/build-errors.md)
- [Runtime Errors Guide](../troubleshooting/runtime-errors.md)

Run this minimal checklist first:

```bash
# Check network and disk
curl -I https://mirrors.tencent.com
df -h

# Build minimal image first to verify base pipeline
manyoyo build --iba TOOL=common
```

If you hit `permission denied`, run:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## Upgrade Guide

### Upgrade MANYOYO

```bash
# Update to latest version
npm update -g @xcanwin/manyoyo

# Verify new version
manyoyo -V
```

### Upgrade Image

```bash
# Build new version image
manyoyo build --iv 1.8.0-common

# Update global configuration
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.8.0-common"
}
EOF

# Clean old images (optional)
manyoyo prune
docker system prune -a  # or podman system prune -a
```

## Uninstall

### Uninstall MANYOYO

```bash
# Uninstall global installation
npm uninstall -g @xcanwin/manyoyo

# Delete configuration directory (optional)
rm -rf ~/.manyoyo/
```

### Clean Images and Containers

```bash
# Delete all MANYOYO containers
docker ps -a | grep my | awk '{print $1}' | xargs docker rm

# Delete all MANYOYO images
docker images | grep manyoyo | awk '{print $3}' | xargs docker rmi

# Clean dangling images
manyoyo prune
```

## Next Steps

After installation, you can:

1. [Quick Start](./quick-start.md) - Learn basic usage workflow
2. [Basic Usage](./basic-usage.md) - Learn common commands and operations
3. [Configuration System](../configuration/README.md) - Set environment variables and configuration files
4. [Command Reference](../reference/cli-options.md) - View all command-line options
