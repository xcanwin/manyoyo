---
title: FAQ | MANYOYO
description: Common MANYOYO problems indexed by symptom, covering install, login, permissions, images and environment variables, each with the shortest path to a fix.
---

# FAQ

Find your symptom; if it is not here, use the "Minimal diagnosis" at the bottom.

## Install and start

**The Linux installer says there is no Docker / Podman**
Install one and re-run the install command; it resumes: `sudo apt update && sudo apt install -y podman`, or follow Docker's documentation. The installer never runs `sudo` for you.

**The browser did not open automatically**
The terminal prints a one-time login URL; open it within 60 seconds, or run `manyoyo` again after it expires. For SSH and other machines without a graphical session see [First Run](../guide/first-run.md).

**I forgot the login password**
Running `manyoyo` on the machine signs you in automatically, no password needed. To reset it, run `manyoyo setup` or edit `serverPass` in `~/.manyoyo/manyoyo.json`.

**I want to go back to the previous version after upgrading**
`manyoyo update --rollback`, see [Daily Use](../guide/daily.md).

## Running and images

**`permission denied`**
Docker / Podman permissions are insufficient. First make sure `docker ps` runs on its own; see [Permission Issues](./runtime-errors.md#permission-denied).

**`pinging container registry failed` / image pull failure**
The registry is unreachable. Check your proxy or build locally, see [Image Pull Failures](../advanced/build-errors.md#image-pull-failures).

**Environment variables have no effect**
`envFile` must be an absolute path. Check with `manyoyo config show --ef /abs/path/example.env`; details in [Environment Variable Issues](./runtime-errors.md#environment-variables-not-taking-effect).

**`manyoyo build` fails**
Most users never need to build. If you must, see [Image Build Issues](../advanced/build-errors.md).

## Minimal diagnosis

```bash
manyoyo doctor                  # check container runtime, image, config and ports
manyoyo doctor --fix            # repair what can be repaired
manyoyo config show -r claude   # the final resolved configuration
manyoyo config command -r claude  # the container command that would run
manyoyo ps                      # container status
```

## Getting help

Open an issue at [GitHub Issues](https://github.com/xcanwin/manyoyo/issues) with reproduction steps, error logs, `manyoyo -v` and system information, and a redacted config snippet. More runtime problems are in [Runtime Issues](./runtime-errors.md).
