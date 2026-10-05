---
title: Manage a container's environment, autostart and network | MANYOYO
description: Change a container's environment variables, autostart script and network rules (host ports, container-to-container access, domain allowlist, exposed ports) from the web "Container" tab at any time, without rebuilding or restarting it.
---

# Manage a container's environment, autostart and network

Set environment variables, an autostart script and the network when you create a container; once it is running, change them any time under **More tabs → Container** in the web workbench — **no restart or rebuild needed**. Risks and boundaries are in [Security Notes](./security.md).

::: tip Old containers
Containers created before this feature do not have it; the Container tab says "created by an older version, recreate to use". Their behavior is unchanged and they are not migrated.
:::

## When changes take effect

| Change | Takes effect |
| --- | --- |
| Environment variables | The next command / newly opened terminal; running processes and already open terminals are unaffected |
| Network rules | About 2 seconds after saving, no restart |
| Exposed ports | Immediately; restored automatically after `serve` restarts |
| Autostart script | The next time the container starts; or click "Run now" |

## Environment variables

- The table view masks values whose names contain `KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `AUTH` / `CREDENTIAL` until you click the eye; the text view is the raw `KEY=VALUE`, one per line.
- Variables live in `~/.manyoyo/containers/<id>/box/env` on your machine and are **not written into the container config** (`podman inspect` / `docker inspect` do not show the values).
- Inside the container you can edit `/run/manyoyo/env` directly (same format); it takes effect for the next command. The page shows "modified inside the container", and invalid lines (e.g. `1BAD=x`) are highlighted and skipped.
- If the container changed the file just before you save, the page reports a conflict and asks you to reload instead of overwriting silently.

## Autostart

Write a bash script under "Autostart". Every time the container starts (creation, restart, start after a `podman machine` restart) the in-container init runs it once and appends output to `/run/manyoyo/autostart.log` ("View log"). With "start this container when serve starts" on, `manyoyo serve` also starts the container.

The container's PID 1 is manyoyo's own init: it reaps zombies and reacts to stop signals (`stop` no longer waits 10 seconds). The autostart script and the agent do not run until the network rules have been applied.

## Network

New containers are **restricted by default**:

- Allowed: the public internet; endpoints manyoyo needs (DNS, your upstream proxy, the Playwright browser service, package mirrors).
- Blocked: other ports on the host, the LAN and private ranges, cloud metadata (`169.254.169.254`), other containers.

Under "Network" you can:

| I want to… | Do this |
| --- | --- |
| Let the container reach a service on the host (e.g. local Ollama) | Add the port under "Host ports it may reach", e.g. `11434`. The service must listen on `0.0.0.0`; services bound to `127.0.0.1` are unreachable |
| Reach a service on the LAN | Add `192.168.1.50 8000` under "Extra IP rules" |
| Let container A reach port 7000 of container B | On **B**, add A and the port under "Allow other containers to reach me" |
| Allow only a few domains such as github.com | Switch outbound to "Allowlist only" and list domains (`*.example.com` supported) |
| Temporarily expose container port 8080 on the host | Add `127.0.0.1:18080 → 8080` under "Port exposure" and click "Open" |
| Go back to the old behavior | Choose "Open" outbound (asks for confirmation); no rules at all |

If you put URLs that point to private addresses in the environment when creating a container (e.g. `OLLAMA_BASE_URL=http://host.containers.internal:11434`, or a model gateway on the LAN), those endpoints are added to the rules automatically so the agent can reach its own model service; they are visible (and removable) under "Network".

### Domain allowlist

"Allowlist only" is enforced by a **filtering proxy** inside the `manyoyo serve` process: the container firewall only allows traffic to that proxy, direct connections are blocked. The proxy allows HTTP(S) (CONNECT) by domain, and rejects any destination that resolves to a private / loopback / link-local address (so it cannot be used to reach the host) unless you explicitly allow that IP in the IP rules. Non-HTTP protocols (ssh, databases) are allowed through "IP rules". Note:

- The proxy listens on `0.0.0.0:8936` (containers can only reach the host through its LAN IP) and relies on a random per-container credential to keep other LAN devices out; the credential exists only in that container's environment.
- It exists only while `serve` runs; when serve stops, HTTP egress of allowlist containers fails (fail closed, never opens up).
- `manyoyo run` on the command line does not provide the proxy; use the web service for containers with a domain allowlist.

### Port exposure

Exposed ports are listened on by serve on the host and each connection is forwarded into the container; by default only `127.0.0.1` is bound. Binding `0.0.0.0` makes it reachable by any device on the LAN, and the page asks you to confirm. A port already in use is reported clearly.

## Configuration fields

You can also set them in `manyoyo.json` globally or under `runs.<name>` when creating a container, see [Config files](../configuration/config-files.md): `autostart` (script text), `autostartOnServe`, `network`. `manyoyo run` writes them too and applies the network rules before starting / connecting; the management UI is the web page.

## FAQ

- **Are rules lost when the container restarts?** No: manyoyo re-applies them after every start, and autostart and the agent do not run before that. While serve is running it watches container start events, so an external restart (`podman restart`) is re-applied automatically.
- **"Network rules failed to apply"?** The page shows the reason; the existing rules stay and the container stays "not released". Typical causes: the image has no `nft` (old image, upgrade it) or the runtime is unavailable.
- **Does Docker work?** Yes. On macOS, Docker Desktop must share `~/.manyoyo` (the user directory is shared by default).
