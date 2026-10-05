---
title: Custom Image | MANYOYO
description: "Build a custom MANYOYO sandbox image: manyoyo build, TOOL sets, image name and version, and the build cache."
---

# Custom Image

The default image `ghcr.io/xcanwin/manyoyo` is pulled automatically on first use, so **most users never need to build**. Read this page only when you want a different tool set, preinstalled dependencies, or your own image.

## Recommended Method: Build with manyoyo

```bash
# Build recommended version (common)
manyoyo build --iv 2.2.0-common

# Verify after build
docker images | grep manyoyo  # or podman images
```

**Advantages**:
- Automatically uses cache to accelerate builds
- First build: Automatically downloads Node.js, JDT LSP, gopls, etc. to `docker/cache/`
- Rebuilding within 2 days: Directly uses local cache, approximately **5x faster**
- After cache expires: Automatically re-downloads latest versions

## Build Options

### Full Version (full)

Includes all supported AI CLI tools and development environments:

```bash
manyoyo build --iv 2.2.0-full
# Or explicitly specify build args
manyoyo build --iv 2.2.0-full --iba TOOL=full
```

**Included Tools**:
- Claude Code
- Codex
- Gemini
- OpenCode
- Python, Node.js, Go, Java development environments
- Common LSP servers

**Image Size**: Approximately 3-5 GB

### Minimal Version (common)

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

### Custom Version

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

### Custom Image Name and Version

```bash
# Custom image name and version
manyoyo build --in myimage --iv 2.2.0-common
# Generates image: myimage:2.2.0-common

# Specify full image name
manyoyo build --in localhost/myuser/sandbox --iv 2.2.0-common
# Generates image: localhost/myuser/sandbox:2.2.0-common
```

### Special Build Parameters

```bash
# Skip Git SSL verification (development environments only)
manyoyo build --iba GIT_SSL_NO_VERIFY=true

# Disable China mirrors (users outside China)
manyoyo build --iba NODE_MIRROR= --iba NPM_REGISTRY=

# Use custom mirror sources
manyoyo build --iba NODE_MIRROR=https://custom-mirror.com
```

## Manual Build (Not Recommended)

If you need more control, you can manually use Docker/Podman commands:

```bash
iv=1.8.0
podman build \
    -t ghcr.io/xcanwin/manyoyo:$iv-full \
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


## Next Steps

- [Installation Details](./installation.md)
- [Image Build Issues](./build-errors.md)
- [Configuration](../configuration/README.md)
