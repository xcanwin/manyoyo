---
title: Playwright Plugin | MANYOYO
description: Let agents in the container drive a browser. Works out of the box; headed, chrome and vnc modes are optional. Includes MCP setup and troubleshooting.
---

# Playwright Plugin

Agents in the container drive a browser with `playwright-cli`, and it **works out of the box with no configuration**: the browser runs on a virtual screen inside the container as a real headed browser (language and timezone follow the host, no automation tells). Use `manyoyo playwright` only when you want a different browser.

## I want to… → command

| I want to… | Command | Where the browser runs |
| --- | --- | --- |
| Let the agent search the web / test pages (default) | Nothing, just `manyoyo run` | Virtual screen in the container |
| Watch the agent operate the browser | `manyoyo playwright up headed` | On the host, with a window |
| Reuse my own Chrome login state | `manyoyo playwright up chrome` | The Chrome you are using |
| No desktop, watch it from a web page | `manyoyo playwright up vnc` | Separate container, via noVNC |

Try it by hand in a container (agents use it the same way):

```bash
manyoyo run -n demo -x sleep infinity &      # start a container in the background
podman exec demo playwright-cli open http://host.containers.internal:3000   # docker exec for docker
podman exec demo playwright-cli snapshot     # read the page back
manyoyo rm demo                              # remove the container when done
```

Local services on the host: default and vnc modes use `host.containers.internal` as above; headed / chrome browsers run on the host, so use `http://127.0.0.1:PORT` instead.

Only one mode is active at a time. After switching, **running containers follow automatically, no rebuild needed**; in a container with a browser session already open, run `playwright-cli close` and then `open` again.

```bash
manyoyo playwright status   # current mode; headed / chrome / vnc get a real probe (opens a page); non-zero exit when unusable
manyoyo playwright down     # back to the default mode
manyoyo playwright logs     # browser service logs
```

## Modes

**headed**: starts a windowed browser service on the host and the agent in the container connects to it. The first run downloads the browser; missing system libraries are only printed as an install command (never a silent sudo). If the system forbids unprivileged user namespaces (e.g. Ubuntu 23.10+) it says so and starts without the sandbox. It needs a graphical session on the host (`DISPLAY`); on Linux without one use `vnc` instead.

**chrome**: drives the Chrome you are using. Open `chrome://inspect/#remote-debugging` in Chrome and enable it; Chrome may show an "Allow remote debugging" prompt, click allow. No container rebuild is needed when Chrome restarts. ⚠️ The agent can act on every site you are logged in to; use only in trusted environments. Extensions are not supported.

**vnc**: builds a small image on top of the manyoyo image the first time and starts the container `my-playwright-vnc`; `up` prints a noVNC URL with the password (`http://127.0.0.1:6080/...`), and `status` shows it again. The noVNC and VNC ports are published on `127.0.0.1` only.

**Extensions** (headed and vnc only): `manyoyo playwright ext-download` fetches the built-in extensions; load them with `up headed --ext-name adguard` or `--ext-path /abs/dir`.

## Host-side agents and MCP

- To let an agent on the host use the same browser, the end of the `up` output has a line like `PLAYWRIGHT_MCP_CONFIG=~/.manyoyo/plugin/playwright/host.json claude`; the host needs `npm i -g @playwright/cli`.
- To use MCP instead of `playwright-cli`: `manyoyo playwright mcp-add` prints the in-container registration commands (stdio, follows the current mode automatically, register once).

## Troubleshooting

- Not sure what is broken → `manyoyo playwright status`
- headed says there is no display → `manyoyo playwright up vnc`
- Port in use → set `plugins.playwright.port` in `~/.manyoyo/manyoyo.json`
- The container cannot reach the host browser → `manyoyo playwright down`, then `up` again (when a mode goes stale, `run` falls back to the default mode and says so)
- Open a local service running on the host → see above; with docker replace `host.containers.internal` by `host.docker.internal`

## Options (`plugins.playwright`, overridable by `runs.<name>`)

| Field | Default | Notes |
| --- | --- | --- |
| `port` | `8935` | Browser service port for headed / chrome / vnc |
| `vncPort` / `novncPort` | `5900` / `6080` | Native VNC and noVNC ports in vnc mode |
| `locale` / `timezoneId` | follow the host | Browser language and timezone |
| `navigatorPlatform` | empty (real value) | Force `navigator.platform`; usually leave unset |
| `disableWebRTC` | `false` | Disable WebRTC |
| `devtoolsActivePortPath` | auto-detect | `DevToolsActivePort` file for chrome mode |
| `extensionProdversion` | `132.0.0.0` | Chrome version used by `ext-download` |

On Linux, headed / chrome listen on `0.0.0.0` (the only way containers can reach them), protected only by a 32-byte random token; restrict the source with a firewall. On macOS they listen on `127.0.0.1` only.

See [CLI Options](../reference/cli-options.md) and the [configuration system](../configuration/README.md).
