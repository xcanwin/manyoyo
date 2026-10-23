---
title: Web Service and Remote Access | MANYOYO
description: Covers starting the manyoyo serve web service, the auth gateway, login flow, remote access (ssh -L) and public-listening hardening.
---

# Web Service and Remote Access

This page covers the `manyoyo serve` web service: how to start it, sign in and reach it remotely. Risks and boundaries are in [Security Notes](./security.md); `ssh -L` access on SSH machines is in [First Run](./first-run.md).

Once a container is running, change its environment variables, network rules and autostart script any time on the "Set container" tab, see [Manage env, network and autostart](./container-manage.md).

The web UI provides three interaction modes: `Command`, `AGENT`, and `Interactive Terminal`. `AGENT` mode requires `agentPromptCommand` to be configured on the session (template must include `{prompt}`).

## Small chat features

- **Images**: paste or drag a screenshot into the input box in AGENT mode; on a phone tap "Add image" at the bottom left to pick from the photo library. Up to 5 images per message, 10MB each; png, jpeg, gif and webp. Images live in the container's state directory and are deleted with the container. Containers created before 2.3.0 have no such directory; recreate them to send images. Whether the model can read images depends on the model you use.
- **Model address blocked**: when the container uses a network policy such as "allowlist only" and the AGENT's own model address is not allowed, the chat immediately shows "Model address xxx is blocked by the network policy"; click "Allow and retry" to allow it and resend the last message.
- **Rewind**: the "⋯" under each prompt you sent has "Rewind to here". Choose "Restore conversation and files", "Conversation only" or "Files only"; before changing anything it lists the files that will be reverted, deleted or restored. Claude rewinds exactly to that turn; other agents continue with the remaining chat history in a new session. A snapshot of the working directory is taken before and after every turn (respecting `.gitignore`; if the directory is too large to snapshot within 3 seconds, that turn cannot rewind files). A rewind can itself be undone: it takes a "before rewind" snapshot first.
- **Changes per turn**: on the "Changes" page switch to "Per turn" to see which files a turn changed; when the working directory is not a git repository (for example quick chat) this is the default view.
- **Delete / hide**: in the same menu, "Delete this group and later ones" removes the conversation only and leaves files alone; "Hide this group from the page" only collapses it, the agent still remembers, and you can expand or unhide it any time.

## Listen Address and Startup

`serve` only supports `<ip:port>`, e.g. `127.0.0.1:3000`, `0.0.0.0:3000`.

Default listen address is `127.0.0.1:3000`.

```bash
# Local access only (default)
manyoyo serve

# Custom listen address
manyoyo serve 127.0.0.1:3000

# LAN access (requires strong password + firewall)
manyoyo serve 0.0.0.0:3000 -U admin -P 'StrongPassword'

# Run in background
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d

# Run in background with auto-generated password (prints the password for this run)
manyoyo serve 127.0.0.1:3000 -d

# Stop a specific background server
manyoyo serve 127.0.0.1:3000 --stop

# Restart a specific background server
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d --restart
```

## Auth Parameter Priority

Web auth parameters are `serverUser` and `serverPass`. They can come from CLI, config files, and env vars.

Priority:

`command-line arguments > runs.<name> > global configuration > environment variables > defaults`

Environment variables:

- `MANYOYO_SERVER_USER`
- `MANYOYO_SERVER_PASS`

Defaults:

- `serverUser`: `admin`
- `serverPass`: auto-generated random password on startup when not explicitly set

## Auth Gateway Behavior

`serve` mode uses a global auth gateway. All pages and APIs require authentication except login-related allowlist routes.

Current anonymous allowlist:

- `/auth/login` (`GET` is the login page, `POST` is the login endpoint)
- `/auth/logout`

Unauthenticated requests to any page path redirect to `/auth/login`; API and `/auth/*` requests get a plain `401`.

## Input Box

Mode (💬 Agent chat / system command), model, send and stop are icon buttons inside the input box; hover to see what each does. In Agent chat:

- Type `/` at the start to list the slash commands that work here (Claude Code only, available after the first turn).
- Type `@` to list files in the working directory; picking one inserts its relative path.
- Use ↑↓ to choose, Enter or Tab to confirm, Esc to close.

## Adding Prompts While a Task Runs

The input box stays enabled while an Agent is working. Once you type something, a "when to insert" button appears left of the send button; use it to choose when the new prompt takes effect (your last choice is remembered, and the placeholder shows the current choice):

- Insert now: interrupts the current round and continues right away with the new prompt (finished work is kept).
- Insert after the current step: waits for the current tool call or message to finish, then interrupts; if nothing finishes within 2 minutes it falls back to "insert now".
- Send after this round: queues the prompt and sends it automatically when the round ends (default).

Queued prompts appear at the bottom of the conversation and can be withdrawn (✕) or edited (✎). "Stop" only stops the current round: queued prompts are kept, and you can cancel them or click "Continue sending". Command mode does not support this.

Sub-agents and task lists show up in the "execution process": a sub-agent is collapsed into one line by default (click to see what it did), and the task list shows a single block with the latest status. While the agent is still working, what it is saying appears inside the execution process; the reply box shows up only when the turn ends, and it holds the final answer. The "align to bottom" button on the right keeps the bottom of that execution process pinned to the bottom of the window until you scroll yourself.

## Sessions, Changes and Notifications

- Session names: without a remark, the title the Agent generated (only Claude Code does this today) is used, otherwise the first message. Click the name in the top bar to rename; clear it to go back to the automatic name.
- Pinning: pin an AGENT from its ⋯ menu; its container moves to the top too.
- The top-bar ⋯ menu is grouped by owner: chat belongs to the AGENT; files, terminal, changes and container settings belong to the container. "Changes" lists the changes in the git repository of the working directory; click a file to see its diff.
- Images in replies: when the Agent writes a Markdown image with a path inside the container (e.g. `![screenshot](/root/shot.png)`) it is shown directly. Absolute paths in replies can be clicked to open them in the Files view.
- Finished-task reminders: if a task ends while the page is in the background, the tab title gets a count such as `(1)`. Browser notifications can be turned on in "Settings → Page" (requires HTTPS or localhost).
- When you come back after a while, or the network recovers, the top bar shows sync progress and then "Synced".

When the web UI runs an Agent it adds a system prompt (replies are shown in a web page, how to write images). In "Settings → Agent → System prompt" you can turn off the default system prompt or add your own supplementary one (config field `agentInstructions`); they only set the initial content for containers created afterwards. You can edit it when creating a container, and later in the container's settings; existing containers are not affected by system settings.

## Web Frontend

The `serve` web UI is built with React and shadcn/ui.

- Default URL: `http://127.0.0.1:3000/`; When unauthenticated it redirects to `http://127.0.0.1:3000/auth/login`, then back to `/` after a successful login
- Login goes through the `/auth/login` endpoint and its cookie
- Source lives in `frontend/` at the repo root, a standalone Vite + React + TypeScript project. It uses ES Modules; the rest of the Node project still follows CommonJS conventions

Before working on it for the first time, install its own dependencies separately (it's a large, separate tree that won't slow down everyday `npm install`):

```bash
cd frontend && npm ci && cd ..
```

Then, depending on what you need:

```bash
# Just want to see the current build: build once, then preview via my serve as usual
npm run build:web
manyoyo serve

# Editing frontend/src and want live reload (HMR) — two terminals:
manyoyo serve                # Terminal 1: the real backend (containers, sessions, terminal WebSocket)
npm run dev:web       # Terminal 2: Vite dev server, proxies /api and /auth to 127.0.0.1:3000 by default
```

If `my serve` listens on an address other than the default `127.0.0.1:3000`, override the proxy target for `dev:web` with the `MANYOYO_SERVE_URL` environment variable.

On publish (`npm publish`/`npm pack`), `frontend` is rebuilt automatically and the output is baked into `lib/web/index.html`; running `my serve` in production needs no frontend toolchain beyond Node itself.

## Login and API Access Example

```bash
# 1) Login and store cookie
curl --noproxy '*' -c /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"StrongPassword"}'

# 2) Access API with cookie
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  http://127.0.0.1:3000/api/sessions

# 3) Logout
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/logout
```

## Minimum Security Baseline

- Prefer `127.0.0.1` for local-only access
- If using `0.0.0.0`, set a strong password and restrict source IP via firewall
- Avoid plain-text passwords in shared scripts; prefer protected config or env vars
- Rotate `serverPass` regularly; use isolated credentials in shared environments

## Common Issue

### `401 Unauthorized`

Check in this order:

1. Ensure `/auth/login` succeeded and cookie is attached
2. Ensure `-U` / `-P` matches effective config
3. Run `manyoyo config show` and verify final source of `serverUser` / `serverPass`

## Related Docs

- [CLI Reference](../reference/cli-options.md)
- [Configuration Overview](../configuration/README.md)
- [Configuration Files Details](../configuration/config-files.md)
