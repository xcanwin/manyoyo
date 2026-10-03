---
title: First Run | MANYOYO
description: First-time setup after installing, using the four-step web wizard (agent, key, work directory, password), or the command line wizard manyoyo setup with ssh -L access on machines without a graphical session.
---

# First Run

The first-time setup comes in two flavors, depending on whether your machine has a graphical session.

## With a graphical session: the web wizard

When installation finishes, follow the on-screen prompts (with a graphical session the browser opens already signed in). Four steps:

1. Pick an agent (Claude Code / Codex / Gemini / OpenCode)
2. Enter your API key (or a compatible service's Base URL) and optionally click "Test connection"
3. Choose the working directory (the agent can only see this)
4. Set a login password (required the first time, at least 8 characters, username `admin`), then save and start chatting

The progress bar at the top shows the container runtime and image preparation; you can fill in the first three steps while it is still running.

## Without a graphical session (SSH, servers): the command line wizard

An SSH session or a Linux machine without a graphical session does not open a browser. The one-line installer asks how to finish the first setup:

```
1) Configure in the terminal (recommended)     <- Enter picks this and starts manyoyo setup
2) Start the web UI and open it from your own computer (needs SSH port forwarding)
3) Not now, I will run manyoyo setup later
```

You can enter the command line wizard any time:

```bash
manyoyo setup
```

It follows the same four steps as the web wizard: agent → access (official API key or a compatible service, key and model) → work directory → login password, then optionally apt / npm / pip mirrors (keys and passwords are not echoed). It needs an interactive terminal; without one (scripts, CI, `ssh host '…'`) the installer only installs and starts no service, and you run `manyoyo setup` yourself afterwards.

When it finishes, the web service runs in the background on `127.0.0.1:<port>`. From **your own computer**, forward the port and open the browser:

```bash
ssh -L <port>:127.0.0.1:<port> <user>@<server>
# then open http://127.0.0.1:<port>; user admin, password is the one set in manyoyo setup
```

If the guess is wrong, force it with `manyoyo --headless` (no graphical session) or `manyoyo --gui` (graphical session), or set the environment variable `MANYOYO_HEADLESS=1` or `0`. More remote-access options are in [Web Server Authentication](./web.md).

## Next Steps

- [Daily Use](./daily.md)
- [Run Agents from the Command Line](./basic-usage.md)
- [Migrate Existing Agent Configs](./migrate.md)
