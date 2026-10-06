---
title: Manage a container's environment, network and autostart | MANYOYO
description: Change a container's environment variables, network rules and autostart script (host ports, container-to-container access, domain allowlist, exposed ports) from the web "Container" tab at any time, without rebuilding or restarting it.
---

# Manage a container's environment, network and autostart

Set environment variables, an autostart script and the network when you create a container; once it is running, change them any time under **More tabs → Container** in the web workbench — **no restart or rebuild needed**. Risks and boundaries are in [Security Notes](./security.md).

::: tip Old containers
Containers created before this feature do not have it; the Container tab says "created by an older version, recreate to use". Their behavior is unchanged and they are not migrated.
:::

The entry is **Container** in the top bar's "…" (More tabs) menu. The page shows, from top to bottom: environment variables, autostart, network (including port exposure). Environment, autostart and network each have their **own Save button**; port exposure takes effect when you click "Add".

## When changes take effect

| Change | Takes effect |
| --- | --- |
| Environment variables | The next command / newly opened terminal; running processes and already open terminals are unaffected |
| Network rules | About 2 seconds after saving, no restart |
| Exposed ports | Immediately; restored automatically after `serve` restarts |
| Autostart script | The next time the container starts; or click "Run now" |

## Environment variables

- This block has two parts: **environment variable files** (absolute paths on the host, several allowed) and **variables entered directly**. Files are re-read every time a command runs, so editing a file takes effect for the next command; multiple files are read in order (later wins) and directly entered variables win over files. The page shows how many variables each file yielded and which lines were skipped. The autostart script sees a snapshot of the files taken whenever the container's rules are applied at start.
- Directly entered variables: the table view masks values whose names contain `KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `AUTH` / `CREDENTIAL` until you click the eye; the text view is `KEY=VALUE`, one per line.
- **There is one syntax** (text view, environment variable files and `/run/manyoyo/env` in the container are identical): it matches docker / podman env-files — no variable expansion, no command execution, and spaces in a value need no quotes (`KEY=abc 123`); it also accepts shell / dotenv forms: an `export ` prefix is allowed and a matching pair of quotes around the value is removed (`KEY="abc 123"` equals `KEY=abc 123`); `#` starts a comment only at the beginning of a line. Values typed in the table are written back to text with quotes only when necessary (leading / trailing whitespace).
- Variables live in `~/.manyoyo/containers/<id>/box/env` on your machine and are **not written into the container config** (`podman inspect` / `docker inspect` do not show the values).
- Inside the container you can edit `/run/manyoyo/env` directly (same format); it takes effect for the next command. The page shows "modified inside the container", and invalid lines (e.g. `1BAD=x`) are highlighted and skipped.
- Newly opened terminals pick up new variables automatically; in an already open terminal run `reload-env` (running processes are unaffected).
- If the container changed the file just before you save, the page reports a conflict and asks you to reload instead of overwriting silently.

## Network

New containers are **restricted by default**:

- Blocked: other ports on the host, the LAN and private ranges, cloud metadata (`169.254.169.254`), other containers.
- Allowed: the public internet; endpoints manyoyo needs (DNS, your upstream proxy, the Playwright browser service, package mirrors).

Under "Network" you can:

| I want to… | Do this |
| --- | --- |
| Let the container reach a service on the host (e.g. local Ollama) | Add a row under "Host ports it may reach", port e.g. `11434`. The service must listen on `0.0.0.0`; services bound to `127.0.0.1` are unreachable. Verify in the container terminal: `curl --noproxy '*' http://host.containers.internal:11434/` (containers often carry proxy variables, so add `--noproxy`) |
| Reach a service on the LAN | Add a row under "Extra IP rules": IP `192.168.1.50`, port `8000` |
| Let container A reach port 7000 of container B | On **B**, add a row under "Allow other containers to reach me": source container A, port `7000` |
| Allow only a few domains such as github.com | Switch outbound to "Allowlist only" and add domains one per row under "Allowed domains" (`*.example.com` supported) |
| Temporarily expose container port 8080 on the host | Add a row under "Port exposure": listen `127.0.0.1`, host port `18080`, container port `8080`; after saving click "Open" on that row |
| Go back to the old behavior | Choose "Open" outbound (asks for confirmation); no rules at all |

If you put URLs that point to private addresses in the environment when creating a container (e.g. `OLLAMA_BASE_URL=http://host.containers.internal:11434`, or a model gateway on the LAN), those endpoints are added to the rules automatically so the agent can reach its own model service; they are visible (and removable) under "Network".

### Domain allowlist

"Allowlist only" lets a container reach just the sites you list. The container firewall only allows traffic to a small dedicated container in the manyoyo network (the filtering proxy, which opens no port on the host); all other egress is blocked. The browser, `curl` and agents in the container use it automatically, with no extra setup. Destinations that resolve to private / local addresses are always refused (so it cannot be used to reach the host) unless you allow them explicitly in "IP rules"; ssh, databases and other non-HTTP protocols are also allowed through "IP rules".

- **The agent's model service goes through it too**: its domain (e.g. the host of `ANTHROPIC_BASE_URL`) must be in the allowlist. When a container is created, domains of URLs in its environment (including environment variable files) are added automatically; for existing containers, after switching to "Allowlist only" the page lists the domains found in the environment as buttons you can click to add.
- **Page won't load, clicks do nothing?** Open **Recently blocked** on the "Container" tab: it lists sites the container tried to reach that are not in the allowlist (images, CDNs, ...); click "Allow" and it takes effect immediately, no restart. The browser's own background requests are folded into "Browser background requests" and can be ignored. While an agent is running, a newly blocked site is also announced once in the conversation.
- Blocked requests get a `403`.
- The proxy container is created and revived by manyoyo automatically, named like `manyoyo-egress-xxxxxxxx`; do not delete or modify it. It does not depend on `serve`; the command line and the web UI both use it.

### Port exposure

Exposed ports are listened on by serve on the host and each connection is forwarded into the container; by default only `127.0.0.1` is bound. Like the other rules they take effect when you click "Save network rules", and you can also fill them in when creating a container. Binding `0.0.0.0` makes the port reachable from the LAN / the internet (depending on the host's network and firewall), and the page asks you to confirm. A port already in use is reported clearly.

### Deploying on a public server

These ports listen on `0.0.0.0`, which on a public server means open to the whole internet (each is protected by a credential, but you should still allow only the sources you need in the cloud security group / firewall):

| Port | Purpose | Advice |
| --- | --- | --- |
| The `serve` listen port | Web service | Use a strong password; behind an HTTPS reverse proxy when public, see [Web Service and Remote Access](./web.md) |
| `8935` | Playwright browser service (headed mode, token protected) | Same, do not expose it |
| Exposed ports you bind to `0.0.0.0` | Services inside containers | Prefer `127.0.0.1`, then use `ssh -L` or an HTTPS reverse proxy; if you must expose, restrict source IPs in the firewall |

## Autostart

Write a bash script under "Autostart". Every time the container starts (creation, restart, start after a `podman machine` restart) the in-container init runs it once and appends output to `/run/manyoyo/autostart.log` ("View log"). With "start this container when serve starts" on, `manyoyo serve` also starts the container.

The script runs as root in the container's default directory; write paths as **in-container** paths (the container path of your mounted host directory is the containerPath on the "Config" tab). The output of "Run now" is not shown automatically: click "View log"; script failures are written to that log too, so check it first when debugging.

The container's PID 1 is manyoyo's own init: it reaps zombies and reacts to stop signals (`stop` no longer waits 10 seconds). The autostart script and the agent do not run until the network rules have been applied.

## Configuration fields

You can also set them in `manyoyo.json` globally or under `runs.<name>` when creating a container, see [Config files](../configuration/config-files.md): `autostart` (script text), `autostartOnServe`, `network`. `manyoyo run` writes them too and applies the network rules before starting / connecting; the management UI is the web page.

## FAQ

- **Are rules lost when the container restarts?** No: manyoyo re-applies them after every start, and autostart and the agent do not run before that. While serve is running it watches container start events, so an external restart (`podman restart`) is re-applied automatically.
- **"Network rules failed to apply"?** The page shows the reason; the existing rules stay and the container stays "not released". Typical causes: the image has no `nft` (old image, upgrade it) or the runtime is unavailable.
- **Does Docker work?** Yes. On macOS, Docker Desktop must share `~/.manyoyo` (the user directory is shared by default).
