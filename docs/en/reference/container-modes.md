---
title: Container Modes
description: "Choose between the common, dind and sock container modes and learn how to enable each."
---

# Container Modes

This page helps you decide whether containers need to run inside the sandbox and shows how to enable each mode. There are only three modes: `common`, `dind` and `sock`.

## Comparison

| Mode | Purpose | Isolation | Required option |
|------|---------|-----------|-----------------|
| `common` (default) | Everyday development, no containers inside the sandbox | Strongest | None |
| `dind` | Run containers inside the sandbox (image builds, CI) | Weaker, container gets `--privileged` | `-m dind` |
| `sock` | Control the host's container runtime from inside | Weakest, equals host container access | `-m sock` |

When unsure, use `common`. If you need nesting, prefer `dind` over `sock`. See [Security](../guide/security.md) for the risks of each mode.

Two equivalent ways to enable a mode: the CLI option `-m, --cont-mode <mode>`, or `containerMode` under `runs.<name>` in `~/.manyoyo/manyoyo.json`.

## common (default)

Use it when you do not need Docker/Podman inside the container. With no option, you get common.

```bash
manyoyo run -r claude
manyoyo run -r claude -m common   # explicit, same result
```

Risk: lowest. The container cannot reach the host's container runtime.

## dind

Use it when you need to build images or run containers inside the sandbox. The container starts with `--privileged`, and the services inside stay separate from the host. `dockerd` does not start automatically; run `nohup dockerd &` in the container (Podman needs no daemon).

```bash
manyoyo run -r claude -m dind
```

```json5
{
    runs: {
        claude: { containerMode: "dind" }
    }
}
```

Risk: `--privileged` relaxes kernel-level restrictions, so use it only when needed. For step-by-step usage see [Docker-in-Docker](../advanced/docker-in-docker.md).

## sock

Use it only in the rare case where the container must manage existing containers on the host. The container starts with `--privileged`, mounts the host's `/var/run/docker.sock`, and sets `DOCKER_HOST` and `CONTAINER_HOST`.

```bash
manyoyo run -r claude -m sock
```

Risk: the Agent inside can read or delete any container and image on the host and can reach host files through them. Remove the container as soon as the task is done. See [Security](../guide/security.md).

## Next Steps

- [Security](../guide/security.md)
- [Docker-in-Docker](../advanced/docker-in-docker.md)
- [CLI Options](cli-options.md)
