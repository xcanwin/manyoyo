---
title: Security Notes | MANYOYO
description: MANYOYO security boundaries and usage notes covering the limits of container isolation, YOLO / SOLO, sock mode, public listening, mounts and environment variables.
---

# Security Notes

MANYOYO reduces risk but is not "absolutely safe". Know the points below before using it; other pages give a single sentence and link here.

## Isolation boundary

- The main isolation is a **container, not a virtual machine**; container-escape vulnerabilities are outside what MANYOYO protects against.
- The agent can reach the **directories you mount** and the **environment variables you pass** (API keys included). Mount only what is needed; never mount your whole home directory.
- Containers can reach the network by default, so the agent can reach any address you allow.
- Session history, logs and config live in `~/.manyoyo/` on your machine, and your keys exist only there.

## YOLO / SOLO mode

`-y` / `--yolo` skips the agent's permission prompts, so it can run commands and modify files without asking. Use it only in controlled setups (inside a container, a disposable work directory, a repository with backups).

## Container modes

- `common` (default): a standard container.
- `dind`: containers inside the container, uses `--privileged`, isolation is noticeably weaker.
- `sock`: mounts the host Docker socket, which hands the host's container control to the agent in the container and is **not strong isolation**; use it only when you must operate the host's Docker.

See [Container Modes](../reference/container-modes.md).

## Public listening

`manyoyo serve` listens on `127.0.0.1` by default. When you listen publicly with `0.0.0.0` you must set a strong password (`-P` or `serverPass`) and restrict the source with a firewall; every page and API requires login by default. Authentication details are in [Web Service and Remote Access](./web.md).

## Next Steps

- [Web Service and Remote Access](./web.md)
- [Container Modes](../reference/container-modes.md)
- [Supported Agents](../reference/agents.md)
