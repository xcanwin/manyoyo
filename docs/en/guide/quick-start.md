---
title: Install | MANYOYO
description: Install MANYOYO and its container runtime with one command; follow the on-screen prompts and you can start using the AI agent sandbox in minutes.
---

# Install

Run this one command in a terminal; follow the on-screen prompts when it finishes:

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
```

## macOS / Linux (recommended)

- **macOS**: nothing to install first. The package bundles Node.js, the container runtime and the MANYOYO image (about 1.8GB, a few minutes to download).
- **Linux (Ubuntu 22.04 / Debian 12 or newer)**: if the container runtime is missing, the installer explains why and, with your consent, installs it with sudo.
- macOS needs no administrator password; Linux only uses sudo when you agree to install a missing component.

Next: [First Run](./first-run.md).

## Already have Node.js and Docker/Podman

If Node.js (>= 22) and Docker or Podman are already installed (including WSL on Windows), install with npm:

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

More ways to install (low-privilege npm, from source) are in [Installation Details](../advanced/installation.md).

::: details Slow or cannot reach GitHub?
- **Set a proxy**: run `export https_proxy=http://127.0.0.1:7890` (use your own proxy address) in the terminal before installing; with the macOS system proxy on, it is detected automatically, and `manyoyo update` uses the proxy too.
- **Download manually**: open [Releases](https://github.com/xcanwin/manyoyo/releases/latest), download `manyoyo-<version>-<os>-<arch>.run` (Apple silicon: `macos-arm64`, Intel Mac: `macos-x64`, Linux: `linux-arm64` / `linux-x64`), then run `sh manyoyo-*.run`.
- **Use a mirror**: `MANYOYO_DOWNLOAD_BASE=<mirror URL prefix>` only replaces where the installer package comes from; the checksum list is still fetched from the official GitHub, so a mirror cannot change the content (a tampered package fails verification).

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | MANYOYO_DOWNLOAD_BASE=<mirror URL prefix> sh
```

If an upgrade cannot reach GitHub: download `manyoyo-<version>-<os>-<arch>-app.tar.gz` and `SHA256SUMS` into the same directory, then run `manyoyo update --file <path to the upgrade package>`; or download the full installer and run `sh manyoyo-*.run` to install over it. On failure the screen lists the full URLs of these files.
:::

::: details Advanced options
```bash
# pin a version
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | MANYOYO_VERSION=8.1.0 sh
# force headless (--headless) or graphical (--gui) handling
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh -s -- --headless
# install only: no service, no browser, no question about how to configure (run manyoyo or manyoyo setup yourself afterwards)
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh -s -- --install-only
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
