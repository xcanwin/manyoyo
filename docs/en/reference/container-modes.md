# Container Modes

MANYOYO supports three container modes, providing different levels of container nesting capabilities.

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
manyoyo -y c

# Explicitly specify
manyoyo -m common -y c
manyoyo --cont-mode common -y c
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
// ~/.manyoyo/run/dev.json
{
    "containerMode": "common",  // Or omit (default)
    "envFile": ["anthropic_claudecode"],
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
manyoyo -m dind -y c
manyoyo --cont-mode dind -y c

# Enter shell to use
manyoyo -n dind-dev -m dind -x /bin/bash
```

### Operations Inside Container

#### Use Podman (Recommended)

```bash
# Enter container
manyoyo -n dind-dev -m dind -x /bin/bash

# Use Podman directly inside container
$ podman ps -a
$ podman run hello-world
$ podman build -t myimage .
```

#### Use Docker

```bash
# Enter container
manyoyo -n dind-dev -m dind -x /bin/bash

# Start dockerd manually (needs manual start)
$ nohup dockerd &

# Wait for dockerd to start (about 5-10 seconds)
$ sleep 10

# Use Docker
$ docker ps -a
$ docker run hello-world
$ docker build -t myimage .
```

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
// ~/.manyoyo/run/dind.json
{
    "containerName": "myy-dind",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "volumes": [
        // Mount Docker config (optional)
        "~/.docker:/root/.docker:ro"
    ]
}
```

### Complete Example

```bash
# 1. Create dind configuration
cat > ~/.manyoyo/run/dind.json << 'EOF'
{
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

# 2. Start container
manyoyo -r dind

# 3. AI helps develop (may build Docker images)...

# 4. Exit and enter shell to check
manyoyo -n myy-xxx -x /bin/bash

# 5. Use Podman inside container
$ podman ps -a
$ podman images

# 6. Or start Docker
$ nohup dockerd &
$ docker ps -a
```

## Socket Mount Mode (Dangerous)

### Features

- **Direct access to host container runtime**: Mounts `/var/run/docker.sock`
- **Extremely dangerous**: Container can completely control host's containers
- **Best performance**: No additional overhead
- **Shared images**: Can directly use host's images

### Usage

```bash
# Use sock mode (dangerous!)
manyoyo -m sock -x /bin/bash
manyoyo --cont-mode sock -x /bin/bash
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
manyoyo -n sock-dev -m sock -x /bin/bash

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
manyoyo -n temp-sock -m sock --rm-on-exit -x /bin/bash
```

#### 2. Monitoring and Auditing

```bash
# Log all operations
manyoyo -m sock -x /bin/bash 2>&1 | tee sock-audit.log

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
manyoyo -v "/var/run/docker.sock:/var/run/docker.sock:ro" -x /bin/bash
```

### Configuration Example

```json5
// ~/.manyoyo/run/sock.json (Use with caution!)
{
    "containerName": "myy-sock",
    "containerMode": "sock",  // Dangerous!
    "envFile": ["anthropic_claudecode"]
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
manyoyo -y c  # Default common mode
```

**CI/CD builds** (Need container nesting):
```bash
manyoyo -m dind -y c  # Use dind mode
```

**Container management tool development** (Special scenarios):
```bash
# After careful evaluation, if must use
manyoyo -m sock -x /bin/bash
```

## Troubleshooting

### Common Mode

**Problem**: Need to run containers, but used common mode

**Solution**:
```bash
# Switch to dind mode
manyoyo -n new-container -m dind -y c
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
manyoyo -n sock-container --crm

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
~/.manyoyo/run/dev.json

# dind mode
~/.manyoyo/run/dind.json

# sock mode (use with caution)
~/.manyoyo/run/sock.json
```

### 5. Document Use Cases

Document why specific modes are needed for team understanding.

## Related Documentation

- [Basic Usage](../guide/basic-usage) - Learn basic commands
- [Configuration Examples](../configuration/examples) - View configuration examples
- [Installation Guide](../guide/installation) - Learn about image building
- [Troubleshooting](../troubleshooting/) - Solve container issues
