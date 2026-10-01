---
title: Quick Start | MANYOYO
description: Download the offline package, install MANYOYO and its container runtime with one command, and start using the AI agent sandbox from the browser in minutes.
---

# Quick Start

Goal: **download the offline package → one command → browser**. You do not need to install Node.js, Docker or Podman first, and you do not need to build an image.

> Offline packages currently support macOS (Apple silicon and Intel). For Linux, Windows, or if you already have npm / Docker / Podman, see [Installation](./installation.md) and [Migrate Existing Agent Configs](./migrate.md).

## 1. Download

Open [GitHub Releases](https://github.com/xcanwin/manyoyo/releases/latest) and pick a `.run` file for your Mac:

| Your Mac | `uname -m` output | Full package (recommended) | Lite package |
|---|---|---|---|
| Apple silicon (M series) | `arm64` | `manyoyo-<version>-macos-arm64.run` | `manyoyo-<version>-macos-arm64-lite.run` |
| Intel | `x86_64` | `manyoyo-<version>-macos-x64.run` | `manyoyo-<version>-macos-x64-lite.run` |

- The **full package** (about 1.8GB) bundles Node.js, the container runtime (Podman and its VM) and the MANYOYO image, and works on a clean Mac.
- The **lite package** (about 0.8GB) bundles only Node.js, MANYOYO and the image, and requires Docker Desktop / OrbStack / Podman to be installed and running already.
- Also download `SHA256SUMS-macos-<arch>` for your architecture from the same page to verify the file.
- If a file is split into volumes (`.run.001`, `.run.002`, ...), put them in one directory and merge with `cat manyoyo-*.run.* > manyoyo-merged.run` before continuing (the merged file can be verified as well).

**Download tip for slow networks**: the files are large, so use a resumable download and continue after an interruption:

```bash
curl -L -C - -O <download URL of the file on the Release page>
```

aria2 and other download managers work too.

## 2. Verify (recommended)

```bash
shasum -a 256 -c SHA256SUMS-macos-arm64        # use SHA256SUMS-macos-x64 on Intel
sh manyoyo-*-macos-arm64.run --check           # verifies the package itself, changes nothing
```

## 3. Install with one command

```bash
sh manyoyo-*-macos-arm64.run
```

The installer verifies the package, unpacks to `~/.manyoyo`, creates and starts the container runtime, imports the image in the background, and opens your browser. No administrator password is needed and no system directory is touched; the only change outside `~/.manyoyo` is a small marked `PATH` block in your shell config. The full package takes about 1.5 to 2 minutes.

The script is short; to read it before running: `sed -n '1,/^__MANYOYO_PAYLOAD_BELOW__$/p' manyoyo-*.run`.

## 4. The setup wizard in the browser

When installation finishes the browser opens already signed in. Follow the four steps:

1. Pick an agent (Claude Code / Codex / Gemini / OpenCode)
2. Enter your API key (or a compatible service's Base URL) and optionally click "Test connection"
3. Choose the working directory (the agent can only see this)
4. Save and start chatting

The progress bar at the top shows the container runtime and image preparation; you can fill in the first three steps while it is still running.

## 5. Day to day

Open a new terminal (or run `exec "$SHELL" -l` in the current one), then:

```bash
manyoyo                 # start (or reuse) the local service and open the browser, already signed in
manyoyo update          # upgrade: downloads only what changed; roll back with manyoyo update --rollback
manyoyo uninstall       # uninstall: config, history and workspace are asked one by one, kept by default
```

The service started by `manyoyo` keeps running in the background. To stop it:

```bash
manyoyo serve 127.0.0.1:<port> --stop     # the port is in the address printed at startup
```

After installation the downloaded `.run` file can be deleted.

## Privacy

The installer and the version check **collect and upload nothing**: installation is fully offline; `serve` asks GitHub Releases for a newer version at most once a day with a fixed `User-Agent` and no local information, which you can turn off with `"updateCheck": false` in the global config. Your keys stay in `~/.manyoyo/manyoyo.json` on your machine.

## If something goes wrong

- Install logs are in `~/.manyoyo/logs/install/`; after fixing the problem just run the installer again and it resumes.
- Run `manyoyo doctor` to check the environment and `manyoyo doctor --fix` to repair what can be repaired.
- More in [Troubleshooting](../troubleshooting/README.md).

## Next Steps

- [Basic Usage](./basic-usage.md)
- [Migrate Existing Agent Configs](./migrate.md)
- [Configuration](../configuration/README.md)
- [CLI Reference](../reference/cli-options.md)
- [Troubleshooting](../troubleshooting/README.md)
