---
title: Manage a container's environment, network and autostart | MANYOYO
description: Change a container's environment variables, network rules and autostart script (outbound / inbound rule tables, domain rules, exposed ports) from the web "Set container" tab at any time, without rebuilding or restarting it.
---

# Manage a container's environment, network and autostart

Set environment variables, an autostart script and the network when you create a container; once it is running, change them any time under **More tabs → Set container** in the web workbench — **no restart or rebuild needed**. Risks and boundaries are in [Security Notes](./security.md).

::: tip Old containers
Containers created before this feature do not have it; the Set container tab says "created by an older version, recreate to use". Their behavior is unchanged and they are not migrated.
:::

The entry is **Set container** in the top bar's "…" (More tabs) menu. The page shows, from top to bottom: environment variables, autostart, network (including port exposure). Environment, autostart and network each have their **own Save button**; port exposure takes effect when you click "Add".

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

Network has two rule tables, **Outbound** (container to outside) and **Inbound** (outside to container), in the same format: **Action** (allow / deny), **Target / Source**, **Port** (empty = all), **Protocol**, and row actions (move up / down, pause, delete). Rules are checked **from top to bottom and the first match wins**; the grey locked rows are system defaults, and your own rules go above them.

Besides an IP, a CIDR or a domain (`*.example.com` matches subdomains; outbound only), type `@` to pick a variable:

| Syntax | Meaning |
| --- | --- |
| `@containers` | Other containers |
| `@container:<name>` | A specific container |
| `@host` | The host machine |
| `@private` | Private networks |
| `@public` | The public internet (outbound only) |
| `@metadata` | Cloud instance metadata (outbound only) |
| `@any` | Any address |

You can type `@host` or `@container:name` directly instead of picking from the list.

The container itself and the endpoints manyoyo needs (DNS, upstream proxy, Playwright, package mirrors) are always allowed; you don't write them, and they show as grey rows marked "Required". Rows marked "Mode default" are the defaults of the current mode; rows marked "Derived" appear automatically in the outbound table when another container's inbound allows this one, so you don't add them.

The three outbound modes only decide the default rows at the bottom:

- **Restricted (default)**: denies other containers, the host, private networks and cloud metadata; allows the public internet.
- **Allowlist only**: denies everything else (ports on the host and on other containers must be allowed separately too); only the allow rules you add get through.
- **Custom**: no default rows, anything unmatched is allowed; switching to it asks for confirmation.

Inbound denies other containers and allows the host by default; Custom has no default rows either. Your own rules are kept when you switch modes.

| I want to… | Do this |
| --- | --- |
| Let the container reach a service on the host (e.g. local Ollama) | Add an outbound row: allow `@host`, port `11434`, `tcp`. The service must listen on `0.0.0.0`. Verify: `curl --noproxy '*' http://host.containers.internal:11434/` |
| Let the container reach only github.com and port 11434 on the host | Switch outbound to "Allowlist only" and add two rows: allow `github.com`; allow `@host`, port `11434`, `tcp` |
| Allow only a few sites such as github.com | Switch outbound to "Allowlist only" and add allow rows for the domains (e.g. `github.com`, `*.githubusercontent.com`); add the `@host` row too if you need a host service |
| Block a site | Add an outbound row: deny `*.doubleclick.net` |
| Reach a machine on the LAN | Add an outbound row: allow `192.168.1.50`, port `8000` |
| Let `web` reach port 7000 of `db` | On the container being reached, **`db`**, add an inbound row: allow `@container:web`, port `7000`; `web` needs no change: its outbound table gets an extra row marked "Derived" automatically |
| Temporarily turn a rule off | Click "Pause" |
| Expose container port 8080 on the host | See "Port exposure" below |

The protocol defaults to `all` (any); `tcp` / `udp` only covers that one, and leaving `all` is fine. On inbound, "Container port" is the port the container being reached listens on.

An inbound "allow `@any`" does not open the outbound side of other restricted containers: for them to reach it, allow `@container:<name>` in their outbound, or use `@containers` / `@container:<name>` as the inbound source (the other side's outbound is then opened automatically).

If you put URLs that point to the host or private addresses in the environment when creating a container (e.g. `OLLAMA_BASE_URL=http://host.containers.internal:11434`), the matching allow rule is added automatically; you can see (and delete) it in the table. Network settings saved by older versions are converted to the new format automatically.

### Domain rules

As long as an enabled domain rule exists, in any mode, the container's HTTP(S) traffic goes through a dedicated filtering proxy in the manyoyo network, which decides by the same table; browsers, `curl` and agents in the web terminal, chat and manyoyo commands use it automatically. In a shell you opened yourself with `podman exec` / `docker exec`, run `source /run/manyoyo-sys/env.sh && reload-env` first; for ssh, databases and other non-HTTP protocols use IP rules.

- An exact domain is allowed as soon as it matches (even if it resolves to a private address: writing it means you trust it); a wildcard domain (`*.example.com`) that resolves to the host, a private network or cloud metadata still needs a rule that allows that address.
- Domain rules do not cover programs that connect to an IP directly; those are judged by the IP rules. So a "deny domain" under Restricted or Custom only blocks HTTP(S) that goes through the proxy; use "Allowlist only" to enforce it.
- When going out through an upstream proxy, the domain is resolved by the upstream, which cannot stop DNS rebinding by a malicious domain; don't allow domains you don't trust.
- **The agent's model service domain must be allowed too**: domains of URLs in the environment are added when a container is created; for an existing container switched to "Allowlist only", the page lists them as buttons, one click adds each.
- **A page won't load or a click does nothing?** Open **Recently blocked** on the "Set container" tab and click "Allow": it takes effect immediately (inserted at the top of your rules). Other domains the page references may still be blocked; allow them the same way. The browser's own background requests can be ignored. If a new site is blocked while the agent runs, the chat shows a notice once.
- Blocked requests get a `403`: `ERR_TUNNEL_CONNECTION_FAILED` in the browser, `CONNECT tunnel failed, response 403` in `curl`.
- The proxy container is created by manyoyo, named like `manyoyo-egress-xxxxxxxx`; do not delete it by hand. It does not depend on `serve`.

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

The script runs as root in the container's default directory; write paths as **in-container** paths (the container path of your mounted host directory is the containerPath on the "Container details" tab). The output of "Run now" is not shown automatically: click "View log"; script failures are written to that log too, so check it first when debugging.

The container's PID 1 is manyoyo's own init: it reaps zombies and reacts to stop signals (`stop` no longer waits 10 seconds). The autostart script and the agent do not run until the network rules have been applied.

## Configuration fields

You can also set them in `manyoyo.json` globally or under `runs.<name>` when creating a container, see [Config files](../configuration/config-files.md): `autostart` (script text), `autostartOnServe`, `network`. `manyoyo run` writes them too and applies the network rules before starting / connecting; the management UI is the web page.

## FAQ

- **Are rules lost when the container restarts?** No: manyoyo re-applies them after every start, and autostart and the agent do not run before that. While serve is running it watches container start events, so an external restart (`podman restart`) is re-applied automatically.
- **"Network rules failed to apply"?** The page shows the reason; the existing rules stay and the container stays "not released". Typical causes: the image has no `nft` (old image, upgrade it) or the runtime is unavailable.
- **Does Docker work?** Yes. On macOS, Docker Desktop must share `~/.manyoyo` (the user directory is shared by default).
