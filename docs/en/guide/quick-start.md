---
title: Install | MANYOYO
description: Install MANYOYO and its container runtime with one command; the browser opens the setup wizard and you can start using the AI agent sandbox in minutes.
---

# Install

Run this one command in a terminal; the browser opens the setup wizard when it finishes:

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
```

## macOS / Linux (recommended)

- **macOS**: nothing to install first. The package bundles Node.js, the container runtime and the MANYOYO image (about 1.8GB, a few minutes to download).
- **Linux (Debian / Ubuntu, Ubuntu 22.04 / Debian 12 or newer)**: Docker or Podman must already be installed; the installer tells you how if it is missing.
- No administrator password is needed and no system directory is touched.

Next: [First Run](./first-run.md).

## Already have Node.js and Docker/Podman

If Node.js (>= 22) and Docker or Podman are already installed (including WSL on Windows), install with npm:

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

More ways to install (low-privilege npm, from source) are in [Installation Details](../advanced/installation.md).

::: details Manual download
Open [Releases](https://github.com/xcanwin/manyoyo/releases/latest), download `manyoyo-<version>-<os>-<arch>.run` (Apple silicon: `macos-arm64`, Intel Mac: `macos-x64`), then run `sh manyoyo-*.run`.
:::

::: details Slow or blocked download?
Point the download at a mirror you trust:

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | MANYOYO_DOWNLOAD_BASE=<mirror URL prefix> sh
```

If `raw.githubusercontent.com` is blocked too, use "Manual download" above.
:::

::: details Advanced options
```bash
# pin a version
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | MANYOYO_VERSION=8.1.0 sh
# force headless (--headless) or graphical (--gui) handling
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh -s -- --headless
# install only: no service, no browser, no question about how to configure (run manyoyo or manyoyo setup yourself afterwards)
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh -s -- --install-only
```

By default it is detected automatically: an SSH session, or Linux without `DISPLAY` / `WAYLAND_DISPLAY`, counts as headless. On a headless machine with a terminal the installer asks whether to configure in the terminal or start the web UI, see [First Run](./first-run.md).
:::

## If something goes wrong

- Install logs are in `~/.manyoyo/logs/install/`; after fixing the problem just run the install command again and it resumes.
- Run `manyoyo doctor` to check the environment and `manyoyo doctor --fix` to repair what can be repaired.
- More in [FAQ](../troubleshooting/README.md).

## Next Steps

- [First Run](./first-run.md)
- [Daily Use](./daily.md)
- [Migrate Existing Agent Configs](./migrate.md)
