# Troubleshooting Guide

This page provides a quick index and solutions for common MANYOYO issues.

## Quick Navigation

### Build-Related Issues
- [Image Build Failures](./build-errors#image-build-failures)
- [Image Pull Failures](./build-errors#image-pull-failures)
- [Network Connection Issues](./build-errors#network-connection-issues)
- [Insufficient Disk Space](./build-errors#insufficient-disk-space)

### Runtime Issues
- [Container Startup Failures](./runtime-errors#container-startup-failures)
- [Permission Denied](./runtime-errors#permission-denied)
- [Environment Variables Not Taking Effect](./runtime-errors#environment-variables-not-taking-effect)
- [Cannot Access Host Files from Container](./runtime-errors#cannot-access-host-files-from-container)
- [AI CLI Tool Errors](./runtime-errors#ai-cli-tool-errors)

## Common Issues Quick Reference

| Symptom | Possible Cause | Quick Solution | Detailed Documentation |
|---------|---------------|----------------|------------------------|
| `manyoyo --ib` build fails | Network issues, insufficient disk space | Check network and disk space | [Build Issues](./build-errors) |
| `pinging container registry failed` | Image not built | Run `manyoyo --ib --iv 1.7.0` | [Image Pull Failures](./build-errors#image-pull-failures) |
| Container won't start | Port conflicts, permission issues | Check logs and permissions | [Container Startup Failures](./runtime-errors#container-startup-failures) |
| `permission denied` | Insufficient Docker/Podman permissions | Add user to docker group | [Permission Denied](./runtime-errors#permission-denied) |
| Environment variables not working | File format errors, path errors | Check environment file format | [Environment Variables Not Taking Effect](./runtime-errors#environment-variables-not-taking-effect) |
| AI CLI missing API Key | Environment variables not configured | Configure environment file | [AI CLI Tool Errors](./runtime-errors#ai-cli-tool-errors) |

## Debugging Tools

### View Configuration

```bash
# Display the final effective configuration
manyoyo --show-config

# Display the command that will be executed
manyoyo --show-command

# Display specific run configuration
manyoyo -r claude --show-config
```

### View Container Status

```bash
# List all manyoyo containers
manyoyo -l

# View container logs (Docker)
docker logs <container-name>

# View container logs (Podman)
podman logs <container-name>

# View detailed container information
docker inspect <container-name>
```

### Test Environment Variables

```bash
# View all environment variables in container
manyoyo --ef myconfig -x env

# View specific environment variable
manyoyo --ef myconfig -x 'env | grep ANTHROPIC'

# Test environment file loading
manyoyo --ef myconfig --show-config
```

### Test Network Connectivity

```bash
# Test domestic mirror sources
curl -I https://mirrors.tencent.com

# Test API endpoint
curl -I https://api.anthropic.com

# Test network from within container
manyoyo -x curl -I https://api.anthropic.com
```

## Diagnostic Process

### 1. Complete Installation Verification First

For requirements, version checks, image checks, and test container creation, run the installation verification checklist first:
- [Installation Guide: Verify Installation](../guide/installation#verify-installation)

### 2. Jump to Targeted Troubleshooting

- Build-related issues: [`build-errors`](./build-errors)
- Runtime-related issues: [`runtime-errors`](./runtime-errors)

### 3. Verify Configuration Files

```bash
# Check global configuration
cat ~/.manyoyo/manyoyo.json

# Verify JSON format
cat ~/.manyoyo/manyoyo.json | jq .

# Check run configuration
cat ~/.manyoyo/run/claude.json | jq .
```

### 4. Test Environment Variables

```bash
# Check if environment file exists
ls -la ~/.manyoyo/env/

# View environment file content
cat ~/.manyoyo/env/anthropic_claudecode.env

# Test loading
manyoyo --ef anthropic_claudecode --show-config
```

## Getting Help

If the issue remains unresolved, follow these steps to get help:

### 1. Collect Diagnostic Information

```bash
# System information
uname -a
node --version
docker --version  # or podman --version

# MANYOYO configuration
manyoyo -V
manyoyo --show-config

# Container status
manyoyo -l
docker ps -a | grep my
```

### 2. View Detailed Logs

```bash
# Container logs
docker logs <container-name> 2>&1 | tee manyoyo-error.log

# If build failed
manyoyo --ib --iv 1.7.0 2>&1 | tee build-error.log
```

### 3. Submit an Issue

Visit [GitHub Issues](https://github.com/xcanwin/manyoyo/issues) and provide:
- Problem description and reproduction steps
- Error messages and logs
- System environment information
- Related configuration files (remove sensitive information)

## Related Documentation

- [Build Issues Explained](./build-errors) - Image build related issues
- [Runtime Issues Explained](./runtime-errors) - Container runtime related issues
- [Configuration System](../configuration/) - Configuration files and environment variables
- [Command Reference](../reference/cli-options) - Command line options description
