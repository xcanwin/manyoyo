---
title: Playwright Plugin | MANYOYO
description: Let agents in the container drive a browser. Works out of the box; headed, chrome and vnc modes are optional. Includes MCP setup and troubleshooting.
---

# Playwright Plugin

Agents in the container drive a browser with `playwright-cli`, and it **works out of the box with no configuration**: the browser is Google Chrome running on a virtual screen inside the container as a real headed browser (language and timezone follow the host, no automation tells). By default it passes bot-detection sites such as deviceandbrowserinfo, rebrowser, okasi, incolumitas, browserscan, pixelscan and creepjs (same results as a real Chrome on the same machine; see [Anti-detection and known limits](#anti-detection-and-known-limits)). Use `manyoyo playwright` only when you want a different browser.

## I want to… → command

| I want to… | Command | Where the browser runs |
| --- | --- | --- |
| Let the agent search the web / test pages (default) | Nothing, just `manyoyo run` | Virtual screen in the container |
| Watch the agent operate the browser | `manyoyo playwright up headed` | On the host, with a window |
| Reuse my own Chrome login state | `manyoyo playwright up chrome` | The Chrome you are using |
| No desktop, watch it from a web page | `manyoyo playwright up vnc` | Separate container, via noVNC |

Try it by hand in a container (agents use it the same way). First `cd` into a project directory (the current directory is mounted into the container, so don't run it in `$HOME` or `/`):

```bash
manyoyo run -n demo -x sleep infinity &      # start a container in the background (it keeps holding this terminal; use another one); ready in about 15 s (see it in podman ps)
podman exec demo playwright-cli open http://host.containers.internal:3000   # docker exec for docker
podman exec demo playwright-cli snapshot     # read the page back (a freshly opened page may still be loading; wait a few seconds)
podman exec demo playwright-cli snapshot | grep -o 'isBot[^,]*'   # e.g. read isBot on a detection page (quotes in the output are escaped)
podman exec demo playwright-cli goto https://example.com    # go to another page (when a session is already open)
manyoyo rm demo                              # remove the container when done
```

Local services on the host: default and vnc modes use `host.containers.internal` as above; headed / chrome browsers run on the host, so use `http://127.0.0.1:PORT` instead.

Only one mode is active at a time. After switching, **running containers follow automatically, no rebuild needed**; for a container with a browser session already open, go in this order: `playwright-cli close` → `manyoyo playwright up/down` → `playwright-cli open`.

```bash
manyoyo playwright status   # current mode; headed / chrome / vnc get a real probe (opens a page); non-zero exit when unusable
manyoyo playwright down     # back to the default mode
manyoyo playwright logs     # browser service logs
```

## Modes

**headed**: starts a windowed browser service on the host and the agent in the container connects to it. It uses the Google Chrome installed on the host when there is one; otherwise it falls back to a downloaded Chromium and says so (Chromium has a different brand and codecs, so some detection sites can tell). Missing system libraries are only printed as an install command (never a silent sudo). If the system forbids unprivileged user namespaces (e.g. Ubuntu 23.10+) it says so and starts without the sandbox. It needs a graphical session on the host (`DISPLAY`); on Linux without one use `vnc` instead.

**chrome**: drives the Chrome you are using. Open `chrome://inspect/#remote-debugging` in Chrome and enable it; Chrome shows "Allow remote debugging?" on every new connection (each `playwright-cli open`, each `status`); click Allow, otherwise it times out (`up` waits up to 60 seconds). No container rebuild is needed when Chrome restarts. ⚠️ The agent can act on every site you are logged in to; use only in trusted environments. Extensions are not supported.

**vnc**: builds a small image on top of the manyoyo image the first time and starts the container `my-playwright-vnc`; `up` prints a noVNC URL with the password (`http://127.0.0.1:6080/...`), and `status` shows it again. The noVNC and VNC ports are published on `127.0.0.1` only.

**Extensions** (headed and vnc only): `manyoyo playwright ext-download` fetches the built-in extensions; load them with `up headed --ext-name adguard` or `--ext-path /abs/dir`.

## Host-side agents and MCP

- To let an agent on the host use the same browser, the end of the `up` output has a line like `PLAYWRIGHT_MCP_CONFIG=~/.manyoyo/plugin/playwright/host.json claude`; the host needs the **pinned** CLI: `npm i -g @playwright/cli@0.1.19` (the in-container client and the host browser service must have exactly the same minor version, otherwise you get `428 Playwright version mismatch`; the version is `playwrightCliVersion` in `package.json`).
- To use MCP instead of `playwright-cli`: `manyoyo playwright mcp-add` prints the in-container registration commands (stdio, follows the current mode automatically, register once).

## Anti-detection and known limits

- The browser is Google Chrome stable, driven by [patchright-core](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (an open-source patched Playwright without the CDP automation tell; version and integrity are pinned and verified at build time). Language and timezone come from the browser process's native environment, so pages and Workers agree.
- Behavior is not simulated: mouse paths and typing rhythm are scripted, so behavior-scored sites (such as incolumitas's behavior score) are not guaranteed to pass.
- `playwright-cli eval` and `page.evaluate` inside `run-code` run in the page's main world (same as plain Playwright, so JS globals defined by the page are readable); the image build switches patchright's default "isolated world" back to the main world.
- The timezone follows the host, not the exit IP. When browsing through a proxy, set `plugins.playwright.timezoneId` to the exit region's timezone, otherwise sites like browserscan note "timezone does not match IP".
- A custom `locale` / `timezoneId` takes effect through process environment variables: verified inside the container and on a Linux host; not verified for headed on macOS / Windows (the default, following the host, is unaffected).
- The container has no GPU, so WebGL is software-rendered (SwiftShader); GPU info is not faked. WebRTC is disabled by default (otherwise STUN reveals the host's public IP); set `disableWebRTC: false` for video-conferencing sites.
- pixelscan shows "Masking detected": a real Chrome on the same machine does too (network and platform differences, not automation tells). With WebRTC disabled by default, pixelscan's location check stays at "Collecting Data…" and gives no consistent/inconsistent verdict ("No automated behavior detected" still works); set `disableWebRTC: false` to see the full verdict.

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
| `locale` / `timezoneId` | follow the host | Browser language and timezone (when behind a proxy, set the exit region's timezone) |
| `navigatorPlatform` | empty (real value) | Force `navigator.platform`; usually leave unset |
| `disableWebRTC` | `true` | Disable WebRTC (on by default so the host public IP is not exposed; set `false` for video-conferencing sites) |
| `devtoolsActivePortPath` | auto-detect | `DevToolsActivePort` file for chrome mode |
| `extensionProdversion` | `132.0.0.0` | Chrome version used by `ext-download` |

On Linux, headed / chrome listen on `0.0.0.0` (the only way containers can reach them), protected only by a 32-byte random token; restrict the source with a firewall. On macOS chrome and vnc listen on `127.0.0.1` only; headed also listens on `0.0.0.0` (Playwright rejects the container Host header when bound to loopback only).

See [CLI Options](../reference/cli-options.md) and the [configuration system](../configuration/README.md).
