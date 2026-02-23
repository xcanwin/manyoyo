# Container Modes

MANYOYO supports three container modes, providing different levels of container nesting capabilities.

> Note: Run profiles should be under `runs.<name>` in `~/.manyoyo/manyoyo.json`; `envFile` must use absolute paths.

## Mode Overview

| Mode | Abbreviation | Container Nesting | Security | Use Cases |
|------|------|----------|--------|----------|
| Common | `common` | ❌ Not supported | ⭐⭐⭐⭐⭐ Most secure | Daily development, no container operations needed |
| Docker-in-Docker | `dind` | ✅ Supported | ⭐⭐⭐⭐ Relatively secure | Need to run containers, e.g., CI/CD |
| Socket Mount | `sock` | ✅ Supported | ⭐ Dangerous | Special scenarios, need full privileges |

## Common Mode (Default)

### Features

- **No container nesting capability**: Cannot run Docker/Podman commands inside container
- **Most secure**: Completely isolated, cannot access host's container runtime
- **Lightweight**: No additional overhead
- **Default mode**: No parameters needed

### Usage

```bash
# Default is common mode
manyoyo run -y c

# Explicitly specify
manyoyo run -m common -y c
manyoyo run --cont-mode common -y c
```

### Use Cases

- Daily programming development
- Code writing and testing
- Tasks not involving container operations
- Scenarios requiring highest security

### Limitations

```bash
# Cannot run inside container
docker ps        # ❌ Error: Cannot connect to Docker daemon
podman ps        # ❌ Error: Cannot connect to Podman
docker build     # ❌ Cannot build images
```

### Configuration Example

```json5
// runs.dev in ~/.manyoyo/manyoyo.json
{
    "containerMode": "common",  // Or omit (default)
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "yolo": "c"
}
```

## Docker-in-Docker Mode

### Features

- **Supports container nesting**: Can run containers inside containers
- **Relatively secure**: Uses independent container runtime, doesn't affect host
- **True isolation**: Containers inside container are completely isolated from host
- **Performance overhead**: Needs to run full container runtime inside container

### Usage

```bash
# Use dind mode
manyoyo run -m dind -y c
manyoyo run --cont-mode dind -y c

# Enter shell to use
manyoyo run -n dind-dev -m dind -x /bin/bash
```

### Operations Inside Container (Quick)

```bash
# Enter container
manyoyo run -n dind-dev -m dind -x /bin/bash

# Podman (recommended)
podman ps -a

# Docker (start daemon first)
nohup dockerd &
sleep 10
docker ps -a
```

For full workflows (architecture, performance, security, CI examples), see:  
[Docker-in-Docker Complete Guide](../advanced/docker-in-docker.md)

### Use Cases

- **CI/CD builds**: Need to build and test images inside containers
- **Multi-stage builds**: Test different container configurations
- **Containerized application development**: Develop and test containerized applications
- **Docker Compose**: Run docker-compose inside containers

### Advantages

- ✅ Secure isolation: Containers inside container don't affect host
- ✅ Environment consistency: Can reproduce complete container environment inside container
- ✅ Easy cleanup: Delete outer container, inner containers automatically cleaned
- ✅ Permission control: No need to access host's container runtime

### Limitations

- ⚠️ Performance overhead: Needs to run full container runtime
- ⚠️ Image sharing: Cannot directly access host's images
- ⚠️ Disk usage: Images inside container occupy additional space
- ⚠️ Docker needs manual start: dockerd won't start automatically

### Configuration Example

```json5
// runs.dind in ~/.manyoyo/manyoyo.json
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "volumes": [
        // Mount Docker config (optional)
        "~/.docker:/root/.docker:ro"
    ]
}
```

### In-depth Examples

For complete configuration and end-to-end examples, see:  
[Docker-in-Docker Complete Guide](../advanced/docker-in-docker.md)

## Socket Mount Mode (Dangerous)

### Features

- **Direct access to host container runtime**: Mounts `/var/run/docker.sock`
- **Extremely dangerous**: Container can completely control host's containers
- **Best performance**: No additional overhead
- **Shared images**: Can directly use host's images

### Usage

```bash
# Use sock mode (dangerous!)
manyoyo run -m sock -x /bin/bash
manyoyo run --cont-mode sock -x /bin/bash
```

::: danger Danger Warning
In Socket Mount mode, the container can:
- Access and manipulate all containers on the host
- Create privileged containers to escape to the host
- Delete or modify host's containers and images
- Access data from other containers
- Completely control host's container runtime

**Only use in fully trusted environments!**
:::

### Operations Inside Container

```bash
# Enter container
manyoyo run -n sock-dev -m sock -x /bin/bash

# Directly use host's Podman/Docker
$ podman ps -a     # Shows host's containers
$ docker ps -a     # Shows host's containers
$ docker images    # Shows host's images
```

### Use Cases

- **Container orchestration development**: Develop Docker/Podman related tools
- **Container management tools**: Such as Portainer, Watchtower
- **Special requirements**: Must access host container runtime

### Security Risks

#### Risk 1: Container Escape

```bash
# Container can create privileged containers
docker run --privileged --pid=host -it ubuntu

# Access host from privileged container
nsenter -t 1 -m -u -n -i sh
# Now on the host!
```

#### Risk 2: Data Leakage

```bash
# Can access data from other containers
docker cp <other-container>:/sensitive/data ./

# Can view environment variables of other containers
docker inspect <other-container> | grep -i env
```

#### Risk 3: Malicious Operations

```bash
# Can delete all containers
docker rm -f $(docker ps -aq)

# Can delete all images
docker rmi -f $(docker images -q)

# Can run malicious containers
docker run -d malicious-image
```

### Protection Measures

If you must use sock mode, take these measures:

#### 1. Principle of Least Privilege

```bash
# Only use when needed, delete container immediately after
manyoyo run -n temp-sock -m sock --rm-on-exit -x /bin/bash
```

#### 2. Monitoring and Auditing

```bash
# Log all operations
manyoyo run -m sock -x /bin/bash 2>&1 | tee sock-audit.log

# Regularly check containers
docker ps -a
docker images
```

#### 3. Network Isolation

```bash
# Restrict container network access
# Configure firewall rules on host
```

#### 4. Use Read-only Mount (Some Scenarios)

```bash
# If only need to view, use read-only mount
manyoyo run -v "/var/run/docker.sock:/var/run/docker.sock:ro" -x /bin/bash
```

### Configuration Example

```json5
// runs.sock in ~/.manyoyo/manyoyo.json (Use with caution!)
{
    "containerName": "my-sock",
    "containerMode": "sock",  // Dangerous!
    "envFile": ["/abs/path/anthropic_claudecode.env"]
}
```

## Detailed Mode Comparison

### Feature Comparison

| Feature | Common | Docker-in-Docker | Socket Mount |
|------|--------|------------------|--------------|
| Run containers inside container | ❌ | ✅ | ✅ |
| Access host images | ❌ | ❌ | ✅ |
| Access host containers | ❌ | ❌ | ✅ |
| Environment isolation | ✅ | ✅ | ❌ |
| Security | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐ |
| Performance | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

### Security Comparison

```
Common Mode:
Host
  └─ MANYOYO Container (Complete isolation)
      └─ AI Agent
          └─ No container operation permissions

Docker-in-Docker Mode:
Host
  └─ MANYOYO Container (Isolated)
      ├─ AI Agent
      └─ Independent container runtime
          └─ Nested containers (Isolated)

Socket Mount Mode:
Host
  ├─ MANYOYO Container (Shared socket)
  │   └─ AI Agent
  │       └─ Can completely control host containers!
  └─ Other containers (May be affected)
```

### Performance Comparison

**Startup time**:
- Common: 1-2 seconds (Fastest)
- Docker-in-Docker: 10-15 seconds (Needs to start container runtime)
- Socket Mount: 1-2 seconds (Fast)

**Disk usage**:
- Common: Base image size
- Docker-in-Docker: Base image + nested container images
- Socket Mount: Base image size (shares host images)

**Memory usage**:
- Common: Base container memory
- Docker-in-Docker: Base container + container runtime + nested containers
- Socket Mount: Base container memory

## Selection Guide

### Decision Flow

```
Need to run containers inside container?
├─ No → Use Common mode ✅
└─ Yes → Need to access host's containers?
    ├─ No → Use Docker-in-Docker mode ✅
    └─ Yes → Fully trust operations inside container?
        ├─ No → Reconsider requirements, try to use dind
        └─ Yes → Use Socket Mount mode ⚠️ Dangerous
```

### Recommended Solutions

**Daily development** (Recommended for 95% of users):
```bash
manyoyo run -y c  # Default common mode
```

**CI/CD builds** (Need container nesting):
```bash
manyoyo run -m dind -y c  # Use dind mode
```

**Container management tool development** (Special scenarios):
```bash
# After careful evaluation, if must use
manyoyo run -m sock -x /bin/bash
```

## Troubleshooting

### Common Mode

**Problem**: Need to run containers, but used common mode

**Solution**:
```bash
# Switch to dind mode
manyoyo run -n new-container -m dind -y c
```

### Docker-in-Docker Mode

**Problem**: docker command not available

**Solution**:
```bash
# Use Podman (recommended, works out of the box)
podman ps

# Or manually start dockerd
nohup dockerd &
sleep 10
docker ps
```

**Problem**: Cannot pull images

**Solution**:
```bash
# Check network
ping -c 3 docker.io

# Configure image proxy (if needed)
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
    "registry-mirrors": ["https://mirror.example.com"]
}
EOF
```

### Socket Mount Mode

**Problem**: Insufficient permissions

**Solution**:
```bash
# Check socket file permissions
ls -la /var/run/docker.sock

# Ensure user is in docker group
groups | grep docker
```

**Problem**: Accidentally deleted host containers

**Solution**:
```bash
# Immediately stop using sock mode
manyoyo rm sock-container

# Check host container status
docker ps -a

# Restore from backup (if available)
# Or recreate necessary containers
```

## Best Practices

### 1. Default to Common Mode

Unless you clearly need container nesting, use the default common mode.

### 2. Prefer Docker-in-Docker

If you need container nesting, prefer dind mode over sock mode.

### 3. Minimize Socket Mount Usage

Only use sock mode when absolutely necessary, and take security measures.

### 4. Use Configuration Files

Create dedicated configurations for different modes:

```bash
# Common mode (default)
~/.manyoyo/manyoyo.json (runs.dev)

# dind mode
~/.manyoyo/manyoyo.json (runs.dind)

# sock mode (use with caution)
~/.manyoyo/manyoyo.json (runs.sock)
```

### 5. Document Use Cases

Document why specific modes are needed for team understanding.

## Related Documentation

- [Basic Usage](../guide/basic-usage.md) - Learn basic commands
- [Configuration Examples](../configuration/examples.md) - View configuration examples
- [Installation Guide](../guide/installation.md) - Learn about image building
- [Troubleshooting](../troubleshooting/README.md) - Solve container issues
