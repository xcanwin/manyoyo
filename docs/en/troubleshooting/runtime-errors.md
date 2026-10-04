---
title: "Runtime Issues | MANYOYO"
description: "Troubleshoot MANYOYO runtime problems by symptom, covering permissions, environment variables, network, authentication and AI CLI tool errors."
---

# Runtime Issue Troubleshooting

Look up by symptom: error message, cause, fix. Start with `manyoyo doctor`; add `--fix` to auto-repair what it can (start the container runtime, pull the image, generate default config).

## Container Fails to Start

**Container exits immediately**: the default command finished, the command does not exist, or a required environment variable is missing.

```bash
manyoyo ps                          # check container status
docker logs <container>             # use podman logs for Podman; manyoyo podman logs for the private Podman
manyoyo run -n debug -x /bin/bash   # open a shell to investigate
```

**Port conflict** (`port is already allocated`): stop the container holding the port, or use another port.

```bash
manyoyo ps
manyoyo rm <conflicting-container>
```

**Mount failure** (`mounts denied` / `no such file or directory`): the host path does not exist, or is rejected by the safety check (mounting `/`, `/home` and `$HOME` is not allowed). Mount a specific subdirectory instead.

**Image version mismatch**: list local images with `manyoyo images` and run a specific version.

```bash
manyoyo run --iv 2.1.1-common
```

A missing image is pulled automatically from `ghcr.io/xcanwin/manyoyo`; you do not need to build it. For build problems see [Build Errors](../advanced/build-errors.md).

## Permission Denied

**Symptom**: `permission denied while trying to connect to the Docker daemon socket`.

**Cause**: the current user cannot access the Docker socket.

```bash
sudo usermod -aG docker $USER && newgrp docker
docker ps    # should now run on its own
```

Do not run `sudo manyoyo`: config would then be read from `/root/` instead of `~/`. Podman is rootless by default and needs no sudo.

**Mounted files cannot be read or written**: the container user needs matching permissions on the host files. Mount read-only content with `:ro` (`-v /abs/host:/work:ro`).

**SELinux denies access** (Fedora / RHEL): add `:z` or `:Z` to the mount instead of disabling SELinux.

```bash
manyoyo run -v /abs/host/dir:/work:z
```

## Environment Variables Not Taking Effect

**Symptom**: `echo $ANTHROPIC_AUTH_TOKEN` is empty inside the container, or the agent reports a missing key.

**Causes and checks**:

1. `envFile` / `--ef` only accept **absolute paths**; relative paths and `~` are not expanded.
2. The file must have one `KEY=value` per line (an `export` prefix is also fine). Avoid Windows line endings (`dos2unix file.env`), characters rejected by the safety check in values (`` ; & | ` $ < > ``), and shell variable substitution.
3. Check the final effective values with `config show`:

```bash
manyoyo config show -r claude
manyoyo config show --ef /abs/path/example.env
```

4. Verify inside the container: `manyoyo run -n debug -x env | grep ANTHROPIC`.

**Wrong value for a duplicated variable**: precedence is CLI > `runs.<name>` > global config. `env` overrides by key; `envFile` is appended in the order global, runs, CLI, with later entries winning.

## Host Files Not Visible in the Container

**Cause**: not mounted, or the path is wrong. Only the current directory is mounted by default; mount anything else explicitly (use absolute host paths).

```bash
manyoyo run -v /abs/host/data:/data              # -v can be repeated
manyoyo config command -r <name>                 # preview the final mount arguments
```

Symlinks: mounts resolve to the real path, so a link pointing outside the mounted tree breaks inside the container. Mount the real path directly.

## AI CLI Tool Errors

Confirm the env file takes effect first (previous section), then check per tool. Agent setup is in the [Agents reference](../reference/agents.md).

| Symptom | Cause | Fix |
| --- | --- | --- |
| Claude Code: `Invalid API key` / `Authentication failed` | `ANTHROPIC_AUTH_TOKEN` missing or wrong | Check the key and `ANTHROPIC_BASE_URL` in the env file |
| Claude Code: `model not found` | Model name not supported by the service | Set `ANTHROPIC_MODEL` to a supported name |
| Codex: `No authentication found` / `Unauthorized` | No auth file in the container | Mount `-v /abs/home/.codex/auth.json:/root/.codex/auth.json` |
| Codex: `ECONNREFUSED` / `404 Not Found` | Wrong `OPENAI_BASE_URL` | Use the address given by your provider |
| Gemini: `API key not valid` | Wrong `GEMINI_API_KEY` | Check the env file |
| OpenCode: `Missing API key` | `OPENAI_API_KEY` or similar missing | Add it to the env file |

Persist `envFile` and `volumes` in `runs.<name>`, for example:

```json
{ "runs": { "codex": { "yolo": "cx", "envFile": ["/abs/path/codex.env"], "volumes": ["/abs/home/.codex/auth.json:/root/.codex/auth.json"] } } }
```

`manyoyo init <agent>` imports existing local agent configuration.

## Network Issues

**No network or DNS failure inside the container**:

```bash
manyoyo run -x curl -sI https://example.com   # reproduce
```

- DNS problems: set `"dns": ["8.8.8.8"]` in Docker `daemon.json` and restart Docker.
- Firewall (firewalld) blocking: add the Docker interface to a trusted zone.
- Proxy needed: set `HTTP_PROXY` / `HTTPS_PROXY` in the env file or `env`. To reach the host use `host.docker.internal` (`host.containers.internal` for Podman), not `127.0.0.1`.

## Performance Issues

- Slow start: the first run pulls the image; afterwards use `manyoyo prune` to clean unused resources and avoid a full disk.
- Slow runtime: raise CPU and memory for Docker Desktop / the Podman machine; avoid bind-mounting many small files (such as `node_modules`).

## Debugging Tips

```bash
manyoyo config show -r <name>       # final effective config
manyoyo config command -r <name>    # container command that will run
manyoyo run -n debug -x /bin/bash   # compare with a clean container
manyoyo doctor --json               # environment diagnostics
```

For risks of `sock` / `dind` modes see [Security](../guide/security.md).

## Next Steps

- [Troubleshooting Overview](./README.md)
- [Build Errors](../advanced/build-errors.md)
- [Config Files](../configuration/config-files.md)
