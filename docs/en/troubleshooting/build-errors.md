# Build Issue Troubleshooting

This page covers issues that may occur during MANYOYO image build process and their solutions.

## Image Build Failures

### Problem Description

Errors occur when executing `manyoyo --ib`, build process is interrupted.

### Common Error Messages

```bash
# Network timeout
Error: unable to download from https://...
Error: connection timeout

# Insufficient disk space
Error: no space left on device

# Permission issues
Error: permission denied while trying to connect to the Docker daemon socket
```

### Solutions

#### 1. Check Network Connection

```bash
# Test domestic mirror sources
curl -I https://mirrors.tencent.com

# Test npm mirror
curl -I https://registry.npmmirror.com

# If network is down, check proxy settings
echo $HTTP_PROXY
echo $HTTPS_PROXY
```

**Configure proxy** (if needed):
```bash
# Temporarily set proxy
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080

# Or set proxy in Docker/Podman configuration
# Docker: ~/.docker/config.json
# Podman: ~/.config/containers/containers.conf
```

#### 2. Check Disk Space

```bash
# Check disk space (at least 10GB needed)
df -h

# Clean Docker/Podman cache
docker system prune -a  # or podman system prune -a

# Clean dangling images
manyoyo --irm
```

#### 3. Use --yes to Skip Confirmations

```bash
# Skip all interactive confirmations
manyoyo --ib --iv 1.7.0 --yes
```

#### 4. Modify Mirror Sources for International Users

If you're outside China, you may need to disable domestic mirror sources:

Edit `docker/manyoyo.Dockerfile`, comment out mirror source related ARGs:
```dockerfile
# ARG NODE_MIRROR=https://mirrors.tencent.com/nodejs-release/
# ARG NPM_REGISTRY=https://registry.npmmirror.com
```

Or use empty values:
```bash
manyoyo --ib --iv 1.7.0 --iba NODE_MIRROR= --iba NPM_REGISTRY=
```

#### 5. Step-by-Step Build Debugging

```bash
# First build basic version (faster, fewer issues)
manyoyo --ib --iv 1.7.0 --iba TOOL=common

# After basic version succeeds, build full version
manyoyo --ib --iv 1.7.0 --iba TOOL=full
```

#### 6. View Detailed Build Logs

```bash
# Save build logs
manyoyo --ib --iv 1.7.0 2>&1 | tee build.log

# Search for error keywords
grep -i "error\|failed\|fatal" build.log
```

### Build Timeout

**Problem**: File download timeout during build process

**Solution**:
```bash
# Increase Docker/Podman timeout
# Docker: Edit /etc/docker/daemon.json
{
    "max-concurrent-downloads": 3,
    "max-download-attempts": 5
}

# Restart Docker
sudo systemctl restart docker

# Or use cache acceleration (recommended)
# MANYOYO will automatically cache downloaded files to docker/cache/
# After first build, rebuilding within 2 days will use cache, ~5x faster
```

### Git SSL Verification Issues

**Problem**: Git reports SSL certificate verification failure during build

**Solution**:
```bash
# Skip Git SSL verification during build (not recommended, dev environments only)
manyoyo --ib --iv 1.7.0 --iba GIT_SSL_NO_VERIFY=true
```

## Image Pull Failures

### Problem Description

When running `manyoyo` command, it shows:
```bash
Error: pinging container registry localhost failed
```

### Cause

MANYOYO uses local images by default (`localhost/xcanwin/manyoyo`), which need to be built first.

### Solutions

#### 1. Build Local Image (Recommended)

```bash
# Build image
manyoyo --ib --iv 1.7.0

# Verify image
docker images | grep manyoyo  # or podman images
```

#### 2. Modify Configuration to Use Already Built Image

If you've already built another version of the image:

```bash
# View existing images
docker images | grep manyoyo

# Modify global configuration
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.6.0-full"  # Use existing version
}
EOF
```

#### 3. Specify Image Version

```bash
# Specify version via command line
manyoyo --iv 1.6.0-full -y c
```

### Image Does Not Exist

**Problem**: Specified image version does not exist

**Solution**:
```bash
# List all manyoyo images
docker images | grep manyoyo

# Use existing version
manyoyo --iv <existing-version> -y c

# Or build new version
manyoyo --ib --iv 1.7.0
```

## Network Connection Issues

### DNS Resolution Failure

**Problem**: Cannot resolve domain names during build

**Solution**:
```bash
# Test DNS
nslookup mirrors.tencent.com

# Modify Docker/Podman DNS settings
# Docker: /etc/docker/daemon.json
{
    "dns": ["8.8.8.8", "114.114.114.114"]
}

# Podman: ~/.config/containers/containers.conf
[containers]
dns_servers = ["8.8.8.8", "114.114.114.114"]

# Restart service
sudo systemctl restart docker  # or podman
```

### Firewall Blocking

**Problem**: Firewall blocks container network access

**Solution**:
```bash
# Check firewall status
sudo firewall-cmd --state

# Temporarily allow Docker/Podman network
sudo firewall-cmd --zone=trusted --add-interface=docker0  # or cni-podman0

# Permanent configuration
sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0
sudo firewall-cmd --reload
```

### Proxy Configuration Issues

**Problem**: Network access requires proxy, but proxy not used during build

**Solution**:
```bash
# Configure proxy for build
# Docker: ~/.docker/config.json
{
    "proxies": {
        "default": {
            "httpProxy": "http://proxy.example.com:8080",
            "httpsProxy": "http://proxy.example.com:8080",
            "noProxy": "localhost,127.0.0.1"
        }
    }
}

# Podman: Use environment variables
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1

# Rebuild
manyoyo --ib --iv 1.7.0
```

## Insufficient Disk Space

### Problem Description

Error during build process:
```bash
Error: no space left on device
```

### Solutions

#### 1. Check Disk Space

```bash
# Check disk usage
df -h

# Check Docker/Podman space usage
docker system df  # or podman system df
```

#### 2. Clean Unused Images and Containers

```bash
# Clean all unused resources (dangerous! will delete all unused images and containers)
docker system prune -a

# Or clean step by step
docker container prune  # Clean stopped containers
docker image prune      # Clean dangling images
docker volume prune     # Clean unused volumes

# MANYOYO provided cleanup command
manyoyo --irm           # Clean dangling and <none> images
```

#### 3. Move Docker/Podman Data Directory

If system disk space is insufficient, move data directory to another disk:

**Docker**:
```bash
# Stop Docker
sudo systemctl stop docker

# Move data directory
sudo mv /var/lib/docker /mnt/large-disk/docker

# Modify configuration /etc/docker/daemon.json
{
    "data-root": "/mnt/large-disk/docker"
}

# Start Docker
sudo systemctl start docker
```

**Podman**:
```bash
# Modify configuration ~/.config/containers/storage.conf
[storage]
driver = "overlay"
graphroot = "/mnt/large-disk/podman"
```

#### 4. Clean Build Cache

```bash
# Clean Docker build cache
docker builder prune -a

# Clean MANYOYO cache (if acceleration not needed)
rm -rf docker/cache/
```

## Permission Issues

### Docker Socket Permission Denied

**Problem**:
```bash
Error: permission denied while trying to connect to the Docker daemon socket
```

**Solution**:
```bash
# Solution 1: Add user to docker group (recommended)
sudo usermod -aG docker $USER

# Re-login or run
newgrp docker

# Verify
docker ps

# Solution 2: Use sudo (not recommended)
sudo manyoyo --ib --iv 1.7.0
```

### File Permission Issues

**Problem**: Cannot write files during build

**Solution**:
```bash
# Check directory permissions
ls -la docker/

# Modify permissions
chmod -R 755 docker/

# Check SELinux status (if applicable)
getenforce

# Temporarily disable SELinux (not recommended)
sudo setenforce 0
```

## Platform Compatibility Issues

### ARM64/M1 Mac Issues

**Problem**: Build fails on ARM64 architecture (e.g., M1/M2 Mac)

**Solution**:
```bash
# Specify platform for build
docker build --platform linux/amd64 ...

# Or use buildx
docker buildx build --platform linux/amd64,linux/arm64 ...

# MANYOYO automatically detects platform, usually no manual specification needed
```

### Windows WSL2 Issues

**Problem**: Build fails in Windows WSL2 environment

**Solution**:
```bash
# Ensure Docker Desktop has WSL2 backend enabled
# Ensure current WSL distribution is integrated with Docker

# Check Docker status
docker version

# If cannot connect, restart Docker Desktop
# Or install native Docker in WSL (recommended)
```

## Cache Related Issues

### Cache File Corrupted

**Problem**: Error during build with cache

**Solution**:
```bash
# Clean cache directory
rm -rf docker/cache/

# Rebuild (will re-download)
manyoyo --ib --iv 1.7.0
```

### Cache Not Taking Effect

**Problem**: Cache exists but build is still slow

**Solution**:
```bash
# Check cache directory
ls -la docker/cache/

# Check cache age (files older than 2 days will be re-downloaded)
find docker/cache/ -type f -mtime +2

# Manually update cache timestamp (not recommended)
touch docker/cache/*
```

## Debugging Tips

### Enable Verbose Logging

```bash
# View detailed build process
manyoyo --ib --iv 1.7.0 2>&1 | tee build.log

# Enable debugging in Docker
export DOCKER_BUILDKIT=0  # Use traditional builder for more verbose output
```

### Manual Build Testing

```bash
# Manually build to debug issues
cd docker/
podman build -t localhost/xcanwin/manyoyo:test-full \
    -f manyoyo.Dockerfile .. \
    --build-arg TOOL=full \
    --no-cache \
    --progress=plain  # Show detailed output
```

### Step-by-Step Build

```bash
# Build to specific stage
podman build --target=base -f docker/manyoyo.Dockerfile .

# Test specific build arguments
manyoyo --ib --iv 1.7.0 --iba TOOL=common --yes
```

## Related Documentation

- [Troubleshooting Home](./README.md) - Issue index and quick navigation
- [Runtime Issues](./runtime-errors.md) - Container runtime issues
- [Configuration System](../configuration/README.md) - Configuration files and environment variables
