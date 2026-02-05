---
title: Quick Start | MANYOYO
description: Install MANYOYO, build the sandbox image, and launch Claude Code, Gemini, Codex, or OpenCode in a secure container in 2 minutes.
---

# Quick Start

## Prerequisites

Before getting started, ensure your system meets the following requirements:

- **Node.js** >= 22.0.0 - [Installation Guide](./installation#install-nodejs)
- **Docker** or **Podman** (Podman recommended) - [Installation Guide](./installation#install-podman-recommended)
- **Disk Space**: At least 10GB available
- **Network Connection**: Stable network connection (required for downloading dependencies on first build)

Verify prerequisites:

```bash
# Check Node.js version
node --version  # Should be >= 22.0.0

# Check Docker or Podman
docker --version   # or
podman --version

# Check disk space
df -h
```

::: tip
If required software is not installed, please refer to [Installation Guide](./installation).
:::

## Install manyoyo

```bash
npm install -g @xcanwin/manyoyo
```

For local development and debugging, you can also install directly from the repository:

```bash
npm install -g .
```

## Build Sandbox Image

Works with both Docker and Podman:

```bash
manyoyo --ib --iv 1.7.0
```

Common build parameters:

```bash
manyoyo --ib --iba TOOL=common
manyoyo --ib --iba TOOL=go,codex,java,gemini
manyoyo --ib --in myimage --iv 2.0.0
```

## Start Container and Enter Agent

```bash
manyoyo -y c
```

Common recovery commands:

```bash
manyoyo -n test -- -c            # Claude Code
manyoyo -n test -- resume --last # Codex
manyoyo -n test -- -r            # Gemini
```

## Configure Environment Variables

AI CLI tools require API keys to work. You can provide them via environment variables or configuration files.

### Method 1: Using Environment Variables (Temporary Testing)

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-your-key" \
        -x claude
```

### Method 2: Using Environment Files (Recommended)

Create an environment file:

```bash
# Create directory
mkdir -p ~/.manyoyo/env/

# Create environment file
cat > ~/.manyoyo/env/anthropic.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-your-actual-key-here"
EOF

# Use environment file
manyoyo --ef anthropic -y c
```

### Method 3: Using Run Configuration (Most Recommended)

Create a run configuration:

```bash
# Create directory
mkdir -p ~/.manyoyo/run/

# Create run configuration
cat > ~/.manyoyo/run/claude.json << 'EOF'
{
    "envFile": ["anthropic"],
    "yolo": "c"
}
EOF

# Use run configuration (simplest)
manyoyo -r claude
```

For detailed configuration, refer to:
- [Environment Variables Guide](../configuration/environment)
- [Configuration Files Guide](../configuration/config-files)
- [Configuration Examples](../configuration/examples)

## Troubleshooting

Common issues are now centralized in troubleshooting docs. Start here:

- [Troubleshooting Guide](../troubleshooting/)
- [Build Errors Troubleshooting](../troubleshooting/build-errors)
- [Runtime Errors Troubleshooting](../troubleshooting/runtime-errors)

For a minimal quick check, run:

```bash
# Check whether image is built
docker images | grep manyoyo

# Verify environment variables are loaded
manyoyo --ef anthropic --show-config

# Test container
manyoyo -x echo "Hello MANYOYO"
```

## Next Steps

Now that you've completed the quick start, you can continue with:

- [Installation Guide](./installation) - Learn more about installation options and build parameters
- [Basic Usage](./basic-usage) - Learn more commands and operations
- [Configuration System](../configuration/) - Master advanced configuration techniques
- [Command Reference](../reference/cli-options) - View all command options
