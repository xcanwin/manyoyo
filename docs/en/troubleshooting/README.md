# Troubleshooting Guide

Use this page to quickly locate common MANYOYO issues and run the shortest diagnostic path.

## Quick Entry

- Build failures: [`build-errors`](./build-errors.md)
- Runtime failures: [`runtime-errors`](./runtime-errors.md)

## Quick Reference

| Symptom | Possible Cause | Quick Command | Details |
| --- | --- | --- | --- |
| `manyoyo --ib` fails | network/disk/permission | `df -h`, `manyoyo --ib --iv 1.8.0-common` | [Build Issues](./build-errors.md) |
| `pinging container registry failed` | local image not built | `manyoyo --ib --iv 1.8.0-common` | [Image Pull Failures](./build-errors.md#image-pull-failures) |
| `permission denied` | Docker/Podman permission issue | `groups`, `docker ps` | [Permission Issues](./runtime-errors.md#permission-denied) |
| env vars not effective | invalid `envFile` path/format | `manyoyo --ef /abs/path/example.env --show-config` | [Env Var Issues](./runtime-errors.md#environment-variables-not-taking-effect) |

## Minimal Diagnostic Flow

1. Basic checks

```bash
manyoyo -V
node --version
docker --version   # or podman --version
```

2. Inspect final config and command

```bash
manyoyo --show-config
manyoyo --show-command
manyoyo -r claude --show-config
```

3. Check images and containers

```bash
docker images | grep manyoyo   # or podman images
manyoyo -l
```

4. Verify env file loading (`--ef` only accepts absolute paths)

```bash
manyoyo --ef /abs/path/anthropic_claudecode.env --show-config
manyoyo --ef /abs/path/anthropic_claudecode.env -x env | grep ANTHROPIC
```

## Config Checks

- Run profiles are under `runs.<name>` in `~/.manyoyo/manyoyo.json`.
- `manyoyo -r <name>` only reads `runs.<name>` and does not read `~/.manyoyo/run/*.json`.
- `envFile` must be an array of absolute paths.

## Getting Help

1. Collect diagnostic info

```bash
uname -a
manyoyo -V
manyoyo --show-config
manyoyo -l
```

2. Export logs

```bash
manyoyo --ib --iv 1.8.0-common 2>&1 | tee build-error.log
docker logs <container-name> 2>&1 | tee runtime-error.log  # or podman logs
```

3. Submit an issue

- Repo: [GitHub Issues](https://github.com/xcanwin/manyoyo/issues)
- Include: reproduction steps, logs, system info, and redacted config snippets.
