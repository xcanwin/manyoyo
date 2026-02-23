# Runtime Issue Troubleshooting

This page covers issues that may occur during MANYOYO container runtime and their solutions.

## Container Startup Failures

### Problem Description

After executing `manyoyo` command, container fails to start or exits immediately.

### Common Error Messages

```bash
# Container exits immediately
Error: container exited with code 1

# Port conflict
Error: address already in use

# Mount failure
Error: error mounting ... permission denied
```

### Solutions

#### 1. View Container Logs

```bash
# View container logs
docker logs <container-name>  # or podman logs

# View real-time logs
docker logs -f <container-name>

# View last 100 lines of logs
docker logs --tail 100 <container-name>
```

#### 2. Check Port Conflicts

```bash
# View all containers
docker ps -a

# If port conflict exists, stop conflicting container
docker stop <conflicting-container>

# Or use different container name
manyoyo run -n my-$(date +%m%d-%H%M) -y c
```

#### 3. Check Mount Permissions

```bash
# Check host directory permissions
ls -la /path/to/host/dir

# Modify permissions (if needed)
chmod 755 /path/to/host/dir

# Check SELinux status (if applicable)
getenforce

# Add SELinux label
chcon -Rt svirt_sandbox_file_t /path/to/host/dir
```

#### 4. Use Debug Mode

```bash
# Enter shell directly for debugging
manyoyo run -n debug-container -x /bin/bash

# View container internal state
pwd
ls -la
env | sort
```

#### 5. Check Container Configuration

```bash
# View detailed container information
docker inspect <container-name>

# Check mount points
docker inspect <container-name> | jq '.[0].Mounts'

# Check environment variables
docker inspect <container-name> | jq '.[0].Config.Env'
```

### Container Exits Immediately

**Problem**: Container exits immediately after starting

**Solution**:
```bash
# Check exit code
docker ps -a | grep <container-name>

# View exit reason
docker logs <container-name>

# Common reasons:
# 1. Command completed execution (normal exit)
# 2. Command does not exist or path error
# 3. Program crashed due to missing environment variables

# Keep container running (for debugging)
manyoyo run -n debug -x sleep infinity
```

### Image Version Mismatch

**Problem**: Image version used does not match configuration

**Solution**:
```bash
# View currently used image
manyoyo config show | grep imageVersion

# View available images
docker images | grep manyoyo

# Unify version
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.8.0-common"
}
EOF
```

## Permission Denied

### Problem Description

Shows `permission denied` or cannot access Docker/Podman.

### Docker/Podman Permissions

**Error message**:
```bash
Error: permission denied while trying to connect to the Docker daemon socket
```

**Solution**:

#### Solution 1: Add User to docker Group (Recommended)

```bash
# Add current user to docker group
sudo usermod -aG docker $USER

# Re-login or run
newgrp docker

# Verify
docker ps
id | grep docker
```

#### Solution 2: Use sudo (Not Recommended)

```bash
# Run with sudo
sudo manyoyo run -y c

# Note: Using sudo may cause config file path issues
# Config files will be from /root/ instead of ~/
```

#### Solution 3: Configure Podman Rootless Mode (Recommended)

```bash
# Podman supports rootless mode by default
# No sudo needed, use directly
podman ps

# If there are issues, reset Podman
podman system reset
```

### File Access Permissions

**Problem**: Cannot access mounted files from within container

**Solution**:
```bash
# Check file permissions
ls -la /path/to/file

# Modify file permissions
chmod 644 /path/to/file

# Modify directory permissions
chmod 755 /path/to/dir

# For read-only files, use read-only mount
manyoyo run -v "/path/to/file:/container/file:ro" -y c
```

### SELinux Permission Issues

**Problem**: Mount fails on systems with SELinux enabled

**Solution**:
```bash
# Check SELinux status
getenforce

# Temporarily disable (not recommended)
sudo setenforce 0

# Correct solution: Add SELinux label
chcon -Rt svirt_sandbox_file_t /path/to/host/dir

# Or add :z or :Z flag when mounting
manyoyo run -v "/path/to/dir:/container/dir:z" -y c
```

## Environment Variables Not Taking Effect

### Problem Description

Cannot read set environment variables from within container, AI CLI tools report missing required environment variables.

### Common Errors

```bash
# Claude Code
Error: Missing required environment variable: ANTHROPIC_AUTH_TOKEN

# Codex
Error: No authentication found

# Gemini
Error: API key not found
```

### Solutions

#### 1. Check Environment File Format

**Correct format**:
```bash
# ~/.manyoyo/env/anthropic_claudecode.env
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

**Common errors**:
```bash
# Error: Using Windows line endings
export ANTHROPIC_AUTH_TOKEN="sk-xxx^M"  # ^M is \r\n

# Error: Missing quotes (when value contains special characters)
export ANTHROPIC_BASE_URL=https://api.anthropic.com/v1?key=xxx

# Error: Using shell variable substitution
export TOKEN=$MY_TOKEN  # $MY_TOKEN may be empty at build time
```

**Fix methods**:
```bash
# Convert line endings
dos2unix ~/.manyoyo/env/anthropic_claudecode.env

# Or use sed
sed -i 's/\r$//' ~/.manyoyo/env/anthropic_claudecode.env

# Check file content
cat -A ~/.manyoyo/env/anthropic_claudecode.env
```

#### 2. Confirm File Path is Correct

```bash
# Check environment file exists
ls -la ~/.manyoyo/env/

# Check filename (note case sensitivity)
ls ~/.manyoyo/env/ | grep -i anthropic

# Test loading
manyoyo config show --ef /abs/path/anthropic_claudecode.env
```

**Path rules**:
- `--ef` only accepts absolute paths
- Recommended format: `--ef /abs/path/myconfig.env`

#### 3. Use config show to View Configuration

```bash
# View final effective configuration
manyoyo config show --ef /abs/path/anthropic_claudecode.env

# Check if envFile is loaded correctly
manyoyo config show -r claude | grep -A 5 envFile

# Check env array
manyoyo config show -r claude | grep -A 20 '"env"'
```

#### 4. Verify Environment Variables in Container

```bash
# View all environment variables
manyoyo run --ef /abs/path/anthropic_claudecode.env -x env

# View specific environment variable
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'env | grep ANTHROPIC'

# Test Claude Code
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'echo $ANTHROPIC_AUTH_TOKEN'
```

#### 5. Check Configuration Priority

Environment variable loading order (later loaded overrides earlier):
1. `envFile` in global configuration
2. `envFile` in run configuration
3. Command line `--ef`
4. `env` in global configuration
5. `env` in run configuration
6. Command line `-e`

**Example**:
```bash
# If multiple configuration sources set the same variable, only the last one takes effect
# Global config: ANTHROPIC_MODEL=claude-sonnet-4-5
# Run config: ANTHROPIC_MODEL=claude-opus-4-5
# Final result: claude-opus-4-5 (run config has higher priority)
```

### Environment Variable Value Incorrect

**Problem**: Environment variable is set, but value is incorrect

**Solution**:
```bash
# 1. Check if defined in multiple places
grep -r "ANTHROPIC_AUTH_TOKEN" ~/.manyoyo/

# 2. View final value
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'echo "TOKEN=$ANTHROPIC_AUTH_TOKEN"'

# 3. Check for spaces or special characters
manyoyo run --ef /abs/path/anthropic_claudecode.env -x 'env | grep ANTHROPIC | cat -A'

# 4. Test with new environment file
cat > /tmp/test.env << 'EOF'
export TEST_VAR="test-value"
EOF

manyoyo run --ef /tmp/test.env -x 'echo $TEST_VAR'
```

## Cannot Access Host Files from Container

### Problem Description

Container starts successfully, but cannot access or modify host files from within container.

### Solutions

#### 1. Check Mount Configuration

```bash
# View mount points
docker inspect <container-name> | jq '.[0].Mounts'

# Default mount (current directory)
manyoyo run -y c  # Mounts current directory to same path in container

# Custom mount
manyoyo run --hp /path/to/project -y c
```

#### 2. Check Path is Correct

```bash
# Check in container
manyoyo run -n test -x pwd
manyoyo run -n test -x ls -la

# Check host path
ls -la /path/to/project
```

#### 3. Check File Permissions

```bash
# Host file permissions
ls -la /path/to/file

# Container file permissions
manyoyo run -x ls -la /container/path/to/file

# If permission issue, modify host file permissions
chmod 644 /path/to/file
```

#### 4. Use Additional Mounts

```bash
# Mount additional directories or files
manyoyo run -v "/host/path:/container/path" -y c

# Mount multiple paths
manyoyo \
    -v "/path1:/container/path1" \
    -v "/path2:/container/path2" \
    -y c

# Read-only mount
manyoyo run -v "/sensitive:/container/sensitive:ro" -y c
```

#### 5. Configure Mounts in Configuration File

```json5
// runs.claude in ~/.manyoyo/manyoyo.json
{
    "volumes": [
        "/Users/user/.ssh:/root/.ssh:ro",
        "/Users/user/.gitconfig:/root/.gitconfig:ro",
        "/Users/user/data:/workspace/data"
    ],
    "yolo": "c"
}
```

### Symbolic Link Issues

**Problem**: Mounted directory contains symbolic links, cannot access from container

**Solution**:
```bash
# Resolve symbolic link's real path
readlink -f /path/to/symlink

# Mount real path
manyoyo run --hp $(readlink -f /path/to/dir) -y c

# Or mount both target paths
manyoyo \
    -v "/real/path:/real/path" \
    -v "/symlink/path:/symlink/path" \
    -y c
```

## AI CLI Tool Errors

### Claude Code Errors

#### API Key Error

**Error message**:
```bash
Error: Invalid API key
Error: Authentication failed
```

**Solution**:
```bash
# 1. Check API Key format (should start with sk-)
echo $ANTHROPIC_AUTH_TOKEN

# 2. Check environment file
cat ~/.manyoyo/env/anthropic_claudecode.env

# 3. Test API Key
curl -H "x-api-key: sk-xxx" \
     -H "anthropic-version: 2023-06-01" \
     https://api.anthropic.com/v1/messages

# 4. Recreate environment file
cat > ~/.manyoyo/env/anthropic_claudecode.env << 'EOF'
export ANTHROPIC_AUTH_TOKEN="sk-your-actual-key-here"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
EOF
```

#### Model Not Found

**Error message**:
```bash
Error: model not found
```

**Solution**:
```bash
# Check model name
# Correct model names:
# - claude-opus-4-5
# - claude-sonnet-4-5
# - claude-haiku-4-5

# Update environment file
cat >> ~/.manyoyo/env/anthropic_claudecode.env << 'EOF'
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
EOF
```

### Codex Errors

#### Authentication Failed

**Error message**:
```bash
Error: No authentication found
Error: Unauthorized
```

**Solution**:
```bash
# Ensure authentication file is mounted
manyoyo run -v "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json" -y cx

# Or set in configuration file
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "runs": {
        "codex": {
            "envFile": ["/abs/path/openai_[gpt]_codex.env"],
            "volumes": [
                "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
            ],
            "yolo": "cx"
        }
    }
}
EOF
```

#### Base URL Error

**Error message**:
```bash
Error: connect ECONNREFUSED
Error: 404 Not Found
```

**Solution**:
```bash
# Check Base URL
# Correct format: https://chatgpt.com/backend-api/codex

cat > ~/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
EOF
```

### Gemini Errors

#### API Key Error

**Error message**:
```bash
Error: API key not valid
```

**Solution**:
```bash
# Create correct environment file
cat > ~/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key-here"
export GEMINI_MODEL="gemini-2.0-flash-exp"
EOF

# Test API Key
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY"
```

### OpenCode Errors

**Error message**:
```bash
Error: Missing API key
```

**Solution**:
```bash
# Create environment file
cat > ~/.manyoyo/env/opencode.env << 'EOF'
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
EOF
```

## Network Connection Issues

### Container Cannot Access Network

**Problem**: Container can start, but cannot access external network

**Solution**:
```bash
# 1. Test network in container
manyoyo run -x ping -c 3 8.8.8.8
manyoyo run -x curl -I https://api.anthropic.com

# 2. Check DNS
manyoyo run -x cat /etc/resolv.conf

# 3. Configure Docker/Podman DNS
# Docker: /etc/docker/daemon.json
{
    "dns": ["8.8.8.8", "114.114.114.114"]
}

# Restart Docker
sudo systemctl restart docker

# 4. Check firewall
sudo firewall-cmd --list-all

# 5. Add Docker network to trusted zone
sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0
sudo firewall-cmd --reload
```

### Proxy Settings

**Problem**: Need to access network through proxy

**Solution**:
```bash
# Set proxy in container
manyoyo run -e "HTTP_PROXY=http://proxy:8080" \
        -e "HTTPS_PROXY=http://proxy:8080" \
        -e "NO_PROXY=localhost,127.0.0.1" \
        -y c

# Or set in environment file
cat > ~/.manyoyo/env/proxy.env << 'EOF'
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1
EOF

manyoyo run --ef /abs/path/proxy.env --ef /abs/path/anthropic_claudecode.env -y c
```

## Performance Issues

### Container Startup Slow

**Problem**: Container takes a long time to start

**Solution**:
```bash
# 1. Check image size
docker images | grep manyoyo

# 2. Use minimal image
manyoyo build --iv 1.8.0-common --iba TOOL=common
manyoyo run --iv 1.8.0-common -y c

# 3. Clean unused resources
docker system prune

# 4. Check disk I/O
iostat -x 1 10
```

### Container Runs Slow

**Problem**: Commands execute slowly within container

**Solution**:
```bash
# 1. Check resource limits
docker stats <container-name>

# 2. Adjust resource limits (if using Docker Desktop)
# Increase CPU and memory in Docker Desktop settings

# 3. Check mount performance
# Avoid mounting large numbers of small files
# Consider using volumes instead of bind mounts

# 4. Check host resources
top
df -h
```

## Debugging Tips

### Enable Verbose Logging

```bash
# Enable debugging with environment variable
manyoyo run -e "DEBUG=*" -y c

# View command executed by manyoyo
manyoyo config command -r claude

# View final configuration
manyoyo config show -r claude
```

### Interactive Debugging

```bash
# Enter container shell
manyoyo run -n debug-container -x /bin/bash

# Manually test in container
pwd
ls -la
env | sort
which claude
claude --version

# Test network
ping -c 3 api.anthropic.com
curl -I https://api.anthropic.com

# Test environment variables
echo $ANTHROPIC_AUTH_TOKEN
```

### Container Comparison

```bash
# Create clean container for comparison
manyoyo run -n clean-test --rm-on-exit -x /bin/bash

# Create problem container for comparison
manyoyo run -n problem-test -r claude -x /bin/bash

# Compare configuration differences
docker inspect clean-test > clean.json
docker inspect problem-test > problem.json
diff clean.json problem.json
```

## Related Documentation

- [Troubleshooting Home](./README.md) - Issue index and quick navigation
- [Build Issues](./build-errors.md) - Image build related issues
- [Configuration System](../configuration/README.md) - Configuration files and environment variables
- [Command Reference](../reference/cli-options.md) - Command line options detailed explanation
