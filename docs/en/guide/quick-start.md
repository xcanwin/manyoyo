---
title: Quick Start | MANYOYO
description: Download the offline package, install MANYOYO and its container runtime with one command, and start using the AI agent sandbox from the browser in minutes.
---

# Quick Start

Goal: **download the offline package → one command → browser**. You do not need to install Node.js, Docker or Podman first, and you do not need to build an image.

> Offline packages support macOS (Apple silicon and Intel, the steps below) and Linux (Debian / Ubuntu, see [Linux](#linux-debian-ubuntu)). For Windows, or if you already have npm / Docker / Podman, see [Installation](./installation.md) and [Migrate Existing Agent Configs](./migrate.md).

## 1. Download

Open [GitHub Releases](https://github.com/xcanwin/manyoyo/releases/latest) and pick a `.run` file for your Mac:

| Your Mac | `uname -m` output | Full package (recommended) | Lite package |
|---|---|---|---|
| Apple silicon (M series) | `arm64` | `manyoyo-<version>-macos-arm64.run` | `manyoyo-<version>-macos-arm64-lite.run` |
| Intel | `x86_64` | `manyoyo-<version>-macos-x64.run` | `manyoyo-<version>-macos-x64-lite.run` |

- The **full package** (about 1.8GB) bundles Node.js, the container runtime (Podman and its VM) and the MANYOYO image, and works on a clean Mac.
- The **lite package** (about 0.8GB) bundles only Node.js, MANYOYO and the image, and requires Docker Desktop / OrbStack / Podman to be installed and running already.
- Also download `SHA256SUMS-macos-<arch>` for your architecture from the same page to verify the file.
- If a file is split into volumes (`.run.001`, `.run.002`, ...), download all of them into one directory and use `.run.001` wherever the commands below say `.run` (for example `sh manyoyo-*-macos-arm64.run.001`); the package joins and verifies the volumes itself and tells you which volume is missing or has the wrong size. Alternative: merge manually with `cat manyoyo-*.run.* > manyoyo-merged.run` and use it as a normal `.run`.

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
4. Set a login password (required the first time, at least 8 characters, username `admin`; running `manyoyo` on this Mac still signs you in automatically, the password is for after signing out or for other browsers / devices), then save and start chatting

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

## Managing the private Podman

The full offline package uses MANYOYO's bundled private Podman, which the system `podman` command cannot see.

```bash
manyoyo podman ps -a                 # run once
eval "$(manyoyo podman env)"          # from now on in this terminal: podman ps -a, podman logs ...
```

The function only lives in the current terminal.

## Linux (Debian / Ubuntu)

There is one Linux package and it **does not bundle a container runtime**: it uses the Podman or Docker already on your system (the installer never runs `sudo` and never installs system software). Requires Ubuntu 22.04 / Debian 12 or newer (glibc 2.35+).

```bash
uname -m                                           # x86_64 -> x64, aarch64 -> arm64
sha256sum -c SHA256SUMS-linux-x64                  # verify (SHA256SUMS-linux-arm64 for arm64)
sh manyoyo-<version>-linux-x64.run                 # install
```

1. **Install a container runtime first** (the installer tells you if there is none; run the installer again afterwards and it resumes): `sudo apt update && sudo apt install -y podman`, or install docker following Docker's documentation. Common problems are explained by the installer: docker needs your user in the `docker` group, rootless podman needs `uidmap` and entries in `/etc/subuid` / `/etc/subgid`.
2. **Headed vs. headless is detected automatically**:
   - **Headed** (a graphical session, not SSH): same as macOS, the service starts and the browser opens for the web wizard.
   - **Headless** (SSH login, no `DISPLAY` / `WAYLAND_DISPLAY`): no browser is opened; configure with the command line wizard `manyoyo setup`: pick an agent, enter the key, choose the work directory, set the login password, optionally apt / npm / pip mirrors (keys and passwords are not echoed).
   - Override a wrong guess: the installer and `manyoyo` accept `--headless` / `--gui`, or set `MANYOYO_HEADLESS=1` (headless) / `0` (headed).
3. **Using the web UI from a headless machine**: after setup the service runs on `127.0.0.1:<port>` in the background; forward the port from your own computer, then browse:

   ```bash
   ssh -L <port>:127.0.0.1:<port> <user>@<server>
   # then open http://127.0.0.1:<port>; user admin, password is the one set in manyoyo setup
   ```

   Stop the service with `manyoyo serve 127.0.0.1:<port> --stop`.
4. Upgrade, rollback and uninstall are the same as on macOS: `manyoyo update`, `manyoyo update --rollback`, `manyoyo uninstall` (uninstall only asks whether to delete manyoyo's containers and images; it never touches your Podman / Docker).
5. Download tip: as on macOS, use `curl -L -C - -O <url>` for resumable downloads.

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
