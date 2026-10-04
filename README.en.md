<p align="center">
  <img src="./assets/manyoyo-logo-09-cyberpunk-terminal.svg" alt="MANYOYO logo" width="560" />
</p>

# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO</a></p>
<p align="center"><b>MANYOYO – open-source sandbox for running AI coding agents (Claude Code / Codex / Gemini) safely in Docker/Podman</b></p>
<p align="center">Run Claude Code / Codex / Gemini / OpenCode in YOLO mode inside a container: let the AI go wild without hurting your computer.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@xcanwin/manyoyo"><img alt="npm" src="https://img.shields.io/npm/v/@xcanwin/manyoyo?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/actions/workflows/npm-publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/xcanwin/manyoyo/npm-publish.yml?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

<p align="center">
  <a href="README.md">中文</a> |
  <a href="README.en.md"><b>English</b></a>
</p>
<p align="center">
  Docs: <a href="https://xcanwin.github.io/manyoyo/en/">https://xcanwin.github.io/manyoyo/en/</a>
</p>

---

## Install

### macOS / Linux (recommended)

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
```

When it finishes, follow the on-screen prompts to finish setup. macOS needs nothing installed first. Linux: if the container runtime is missing, the installer explains why and, with your consent, installs it with sudo.

### Already have Node.js and Docker/Podman

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

## Daily use

```bash
manyoyo            # open the web UI
manyoyo update     # upgrade
manyoyo uninstall  # uninstall (config and data are kept by default)
```

## Command line (optional)

```bash
manyoyo init all   # import the agent configs already on this machine
manyoyo run -y c   # start Claude Code in YOLO mode inside the sandbox
```

The default image `ghcr.io/xcanwin/manyoyo` is pulled automatically on first use; run `manyoyo build --iv 2.1.1-common` only if you need a custom image. More commands: [CLI reference](https://xcanwin.github.io/manyoyo/en/reference/cli-options).

## What it does

- **Multiple agents**: `claude`, `codex`, `gemini`, `opencode` behind one entry point
- **Container isolation**: Docker / Podman; the agent only sees the work directory you give it
- **Web UI**: chat, browse files and open a terminal in the browser, phone friendly
- **One config**: run profiles, environment variables, mounts and image arguments in `~/.manyoyo/manyoyo.json`
- **One command** to install, upgrade and uninstall

| | Running the agent CLI directly | MANYOYO |
| --- | --- | --- |
| Host exposure | High | Lower |
| Run boundary | Scattered | Centralised in the container and config |
| Reproducible environment | Weak | Strong (image + config) |
| High-risk mode warnings | Left to the tool | Explicit YOLO / SOLO / sock warnings |

## Security notes

MANYOYO reduces risk but is not "absolutely safe": the main isolation is a container, not a virtual machine; `YOLO / SOLO` can still run dangerous commands; `sock` mode exposes the host Docker socket; set a strong password before listening on a public address. See [Security notes](https://xcanwin.github.io/manyoyo/en/guide/security).

## Docs

- 中文: <https://xcanwin.github.io/manyoyo/>
- English: <https://xcanwin.github.io/manyoyo/en/> ([Install](https://xcanwin.github.io/manyoyo/en/guide/quick-start), [CLI reference](https://xcanwin.github.io/manyoyo/en/reference/cli-options), [Configuration](https://xcanwin.github.io/manyoyo/en/configuration/), [FAQ](https://xcanwin.github.io/manyoyo/en/troubleshooting/))

## License

MIT

## Contributing

[Issues](https://github.com/xcanwin/manyoyo/issues) and pull requests are welcome.
