---
title: Installation Guide | MANYOYO
description: Complete MANYOYO installation guide covering Node.js and Docker/Podman prerequisites, global install, image build options, and common setup issues.
---

# Installation Guide

This page provides a detailed installation guide for MANYOYO, including prerequisites, installation steps, and image building.

## Recommended: one-line install

On macOS and Linux (Debian / Ubuntu) prefer the [one-line install](../guide/quick-start.md); macOS needs no administrator password, and on Linux `sudo` is only used to install a missing container runtime, and only with your consent. The npm / package manager / source methods below are for Windows (WSL), and for users who already have Node.js and Docker / Podman and want to manage versions themselves.

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
manyoyo -v

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

```bash
npm update -g @xcanwin/manyoyo
manyoyo -v
```

## Verify Installation

```bash
manyoyo -v                                      # version
manyoyo init all                                # migrate existing claude/codex/gemini/opencode host config (recommended)
manyoyo run -n test-container -x echo "MANYOYO works!"   # create and run a test container
manyoyo ps                                      # list containers
manyoyo rm test-container                       # remove the test container
manyoyo run -r claude                           # use the initialized run config
```

The default image is pulled automatically on first use; you only need to build for a custom image, see [Custom Image](./custom-image.md). For install or run errors, see [Troubleshooting](../troubleshooting/README.md) and [Build Issues](./build-errors.md).

## Upgrade and Uninstall

Upgrade the image: after building a new tag for a custom image, set `imageVersion` in `~/.manyoyo/manyoyo.json` to `"2.2.0-common"`, then run `manyoyo prune` to remove dangling images.

Uninstall an npm-installed MANYOYO:

```bash
npm uninstall -g @xcanwin/manyoyo
manyoyo ps && manyoyo rm <name>   # remove containers one by one after checking names (optional)
rm -rf ~/.manyoyo/                # delete config, history and logs (optional, irreversible)
```

For offline-package installs, use `manyoyo update` and `manyoyo uninstall`, see [Install](../guide/quick-start.md).

## Offline Package Layout

For maintainers and anyone curious about what is inside. The one-line installer `scripts/install.sh` only downloads, verifies and starts the `.run`; the real installation logic is `install/install.sh` inside the unpacked `.run`.

- **Assets on a Release**: for each platform (`macos` / `linux`) × chip (`arm64` / `x64`) there is one installer `manyoyo-<version>-<os>-<arch>.run` and one upgrade package `manyoyo-<version>-<os>-<arch>-app.tar.gz`, plus one checksum list `SHA256SUMS`, 9 files in total. The `-app.tar.gz` is downloaded by `manyoyo update` automatically (only Node.js and manyoyo, tens of MB); you normally do not need to download it; if GitHub is unreachable, download it with `SHA256SUMS` into the same directory and install it with `manyoyo update --file <package>`.
- **Self-verification**: the `.run` verifies itself before installing. To only verify without installing: `sh manyoyo-*.run --check`; to list the contents: `--list`; to unpack into a directory only: `--extract <dir>`.
- **Compare checksums by hand**: `grep "$(shasum -a 256 manyoyo-*-macos-arm64.run | cut -d' ' -f1)" SHA256SUMS`; one line with the file name means a match.
- **Read the script before running it**: `sed -n '1,/^__MANYOYO_PAYLOAD_BELOW__$/p' manyoyo-*.run`.
- **Volumes**: a file is split into `.run.001`, `.run.002`, ... only when it would exceed GitHub's 2 GiB limit. Download all of them into one directory and run `sh manyoyo-*.run.001`; the installer joins and verifies them itself. You can also merge by hand with `cat manyoyo-*.run.* > manyoyo-merged.run` and use it as a normal `.run`.
- **Install location**: `~/.manyoyo/app/<version>/` holds the program, `app/current` points to the active version; upgrades switch it atomically and keep the previous version for `update --rollback`.

## Next Steps

1. [Install](../guide/quick-start.md): one command to get set up
2. [Basic Usage](../guide/basic-usage.md): common commands and operations
3. [Configuration System](../configuration/README.md): environment variables and config files
