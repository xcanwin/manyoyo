# Complete Guide to Docker-in-Docker

This page provides a comprehensive guide to Docker-in-Docker (DinD) mode, including principles, configuration, best practices, and security analysis.

## What is Docker-in-Docker

Docker-in-Docker refers to the technology of running a Docker daemon inside a Docker container, allowing you to create and manage other containers within a container.

### Use Cases

- **CI/CD Pipelines**: Building and testing Docker images in containerized CI environments
- **Development Environment Isolation**: Providing independent container runtime environments for each project
- **Multi-tenant Container Platforms**: Providing isolated container environments for different users
- **Containerized Application Testing**: Testing applications that require container support

## DinD Implementation in MANYOYO

MANYOYO provides two container nesting solutions:

1. **Docker-in-Docker (dind)**: True container nesting, secure isolation ✅ Recommended
2. **Socket Mount (sock)**: Mount host socket, dangerous but performant ⚠️ Use with caution

This document primarily covers **dind mode**.

## Quick Start

### Basic Usage

```bash
# Start container in dind mode
manyoyo -m dind -x /bin/bash

# Use Podman inside the container (works out of the box)
podman ps -a
podman run hello-world
podman build -t myimage .

# Or use Docker (need to start dockerd first)
nohup dockerd &
sleep 10
docker ps -a
```

### Configuration File Method

```bash
# Create dind configuration
cat > ~/.manyoyo/run/dind.json << 'EOF'
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

# Start using the configuration
manyoyo -r dind
```

## How It Works

### Architecture Diagram

```
Host Machine
  └─ MANYOYO Outer Container (dind mode)
      ├─ Podman/Docker daemon (independent runtime)
      ├─ AI Agent (can operate containers)
      └─ Nested Containers (completely isolated)
          ├─ Application Container A
          ├─ Application Container B
          └─ Application Container C
```

### Technical Implementation

MANYOYO's dind mode is based on the following technologies:

1. **Privileged Container**: The outer container needs certain privileges to run container runtimes
2. **Independent Storage**: Nested containers use an independent storage backend
3. **Network Isolation**: Nested containers have their own network stack
4. **Process Isolation**: Complete PID namespace isolation

## Podman vs Docker

### Podman (Recommended)

**Advantages**:
- Works out of the box, no need to manually start daemon
- Rootless mode, more secure
- Compatible with Docker CLI commands
- Lightweight, less resource usage

**Usage**:
```bash
# Enter dind container
manyoyo -m dind -x /bin/bash

# Use Podman directly
podman ps -a
podman images
podman run -d nginx
podman build -t myapp .
```

### Docker

**Advantages**:
- Full Docker ecosystem support
- Docker Compose support
- Some tools require Docker specifically

**Usage**:
```bash
# Enter dind container
manyoyo -m dind -x /bin/bash

# Start dockerd (run in background)
nohup dockerd > /var/log/dockerd.log 2>&1 &

# Wait for startup to complete
sleep 10

# Verify
docker version
docker ps -a

# Use Docker
docker run hello-world
docker build -t myapp .
```

## Complete Examples

### Example 1: AI-Assisted Containerized Application Development

```bash
# 1. Create dind configuration
cat > ~/.manyoyo/run/dind-dev.json << 'EOF'
{
    "containerName": "my-dind-dev",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "volumes": [
        "~/.docker:/root/.docker:ro"
    ],
    "yolo": "c"
}
EOF

# 2. Start AI-assisted development
manyoyo -r dind-dev

# 3. AI can help with:
#    - Writing Dockerfile
#    - Building images
#    - Running container tests
#    - Debugging container issues

# 4. Check after exiting
manyoyo -n my-dind-dev -x /bin/bash

# 5. View containers and images created by AI
podman ps -a
podman images
```

### Example 2: CI/CD Pipeline

```bash
# 1. Create project configuration
cat > ./myproject/.manyoyo.json << 'EOF'
{
    "containerName": "my-ci",
    "containerMode": "dind",
    "env": [
        "CI=true",
        "NODE_ENV=test"
    ]
}
EOF

# 2. Run CI tasks
manyoyo -r ./myproject/.manyoyo.json -x /bin/bash

# 3. Run tests inside the container
$ npm install
$ npm test

# 4. Build Docker image
$ podman build -t myapp:test .

# 5. Run integration tests
$ podman run --rm myapp:test npm run integration-test

# 6. Cleanup
$ podman rm -f $(podman ps -aq)
```

### Example 3: Multi-stage Build Testing

```bash
# Enter dind container
manyoyo -m dind -x /bin/bash

# Create test Dockerfile
cat > Dockerfile.test << 'EOF'
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EOF

# Build multi-stage image
podman build -f Dockerfile.test -t webapp:test .

# Run test
podman run -d -p 8080:80 webapp:test

# Test access
curl http://localhost:8080

# Cleanup
podman stop $(podman ps -q)
```

## Configuration Options

### Environment Variables

```bash
# Docker configuration
export DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_BUILDKIT=1

# Podman configuration
export CONTAINER_HOST=unix:///run/podman/podman.sock
```

### Storage Configuration

```bash
# Configure Podman storage inside the container
mkdir -p ~/.config/containers
cat > ~/.config/containers/storage.conf << 'EOF'
[storage]
driver = "overlay"
graphroot = "/var/lib/containers/storage"

[storage.options]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
```

### Network Configuration

```bash
# Create custom network
podman network create mynetwork

# Run container using custom network
podman run --network mynetwork -d nginx
```

## Performance Optimization

### 1. Use Build Cache

```bash
# Podman
podman build --layers -t myapp .

# Docker
docker build --cache-from myapp:latest -t myapp .
```

### 2. Multi-stage Parallel Build

```dockerfile
FROM node:22 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

### 3. Use BuildKit

```bash
# Enable BuildKit (faster builds)
export DOCKER_BUILDKIT=1
docker build -t myapp .
```

## Security Analysis

### DinD vs Socket Mount Security Comparison

| Feature | DinD Mode | Socket Mount Mode |
|---------|-----------|-------------------|
| Container Isolation | ✅ Complete isolation | ❌ Can access host containers |
| Image Isolation | ✅ Independent image registry | ❌ Shares host images |
| Container Escape Risk | ⭐⭐⭐⭐ Low | ⭐ High |
| Data Leak Risk | ⭐⭐⭐⭐ Low | ⭐ High |
| Malicious Operation Impact | Limited to outer container | Can affect host |
| Performance Overhead | Yes (independent runtime) | None |

### Security Best Practices

#### 1. Limit Resource Usage

```bash
# Limit CPU and memory
manyoyo -m dind -x "podman run --cpus=1 --memory=512m myapp"
```

#### 2. Use Non-privileged Mode (if possible)

```bash
# Podman rootless mode (more secure)
podman run --security-opt=no-new-privileges myapp
```

#### 3. Scan Images for Security Vulnerabilities

```bash
# Use Trivy to scan
podman run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy image myapp:latest
```

#### 4. Regular Cleanup

```bash
# Clean up unused resources
podman system prune -a --volumes
```

## Troubleshooting

### Docker daemon Fails to Start

**Problem**: `dockerd` command cannot start

**Solution**:
```bash
# Check logs
tail -f /var/log/dockerd.log

# Start manually and view errors
dockerd --debug

# Clean up old socket
rm -f /var/run/docker.sock
```

### Podman Permission Issues

**Problem**: Permission denied error

**Solution**:
```bash
# Check user namespace
podman unshare cat /proc/self/uid_map

# Reset Podman
podman system reset

# Check storage configuration
podman info
```

### Image Pull Fails

**Problem**: Unable to pull images

**Solution**:
```bash
# Check network
ping -c 3 docker.io

# Configure image mirror
mkdir -p /etc/containers
cat > /etc/containers/registries.conf << 'EOF'
[[registry]]
location = "docker.io"
[[registry.mirror]]
location = "mirror.example.com"
EOF

# Or use proxy
export HTTP_PROXY=http://proxy:8080
export HTTPS_PROXY=http://proxy:8080
```

### Storage Space Insufficient

**Problem**: Disk space insufficient

**Solution**:
```bash
# Check storage usage
podman system df

# Clean up unused resources
podman system prune -a --volumes

# Check nested container usage
podman ps -a --size
```

## Limitations and Considerations

### Known Limitations

1. **Performance Overhead**: Nested containers are 10-30% slower than direct containers
2. **Disk Usage**: Independent image storage increases disk usage
3. **Network Complexity**: Multi-layer networking may lead to complex configuration
4. **Some Features Not Supported**: Some advanced Docker features may be unavailable

### Considerations

1. **Exit Cleanup**: Removing the outer container will clean up all nested containers
2. **Data Persistence**: Important data should be mounted to the outer container
3. **Network Ports**: Nested container ports need to be mapped twice
4. **Resource Limits**: Resource limits of the outer container will affect nested containers

## Comparison with Other Solutions

### DinD vs Kaniko

**Kaniko**: Daemonless container image build tool

| Feature | DinD | Kaniko |
|---------|------|--------|
| Requires Privileges | Yes | No |
| Build Speed | Fast | Slower |
| Cache Support | Full | Limited |
| Dockerfile Compatibility | 100% | ~95% |
| Use Case | Development and testing | Production CI/CD |

### DinD vs sysbox

**sysbox**: More secure container runtime

| Feature | DinD | sysbox |
|---------|------|--------|
| Security | Medium | High |
| Setup Complexity | Simple | Complex |
| Compatibility | High | Medium |
| Performance | Medium | Better |

## Best Practices Summary

### Development Environment

```bash
# Use dind mode + Podman
manyoyo -m dind -r claude

# AI-assisted containerized application development
# Fast iteration, testing, debugging
```

### CI/CD Environment

```bash
# Use automation scripts
manyoyo --yes -m dind -x "
  podman build -t myapp:$CI_COMMIT_SHA . &&
  podman run --rm myapp:$CI_COMMIT_SHA npm test
"
```

### Production Environment

**DinD is not recommended**, instead use:
- Dedicated container runtime (Kubernetes)
- Or use daemonless tools like Kaniko

## Related Documentation

- [Container Mode Comparison](../reference/container-modes.md) - Learn about different container modes
- [Basic Usage](../guide/basic-usage.md) - Learn basic commands
- [Configuration Examples](../configuration/examples.md) - View configuration examples
- [Troubleshooting](../troubleshooting/runtime-errors.md) - Solve runtime issues
