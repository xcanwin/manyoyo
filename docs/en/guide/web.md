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
- **Rewind**: click the "Rewind to here" button under a prompt you sent and choose "Restore conversation and files", "Conversation only" or "Files only"; before changing anything it lists the files that will be reverted, deleted or restored. Claude rewinds exactly to that turn; other agents continue with the remaining chat history in a new session. A snapshot of the working directory is taken before and after every turn (respecting `.gitignore`; if the directory is too large to snapshot within 3 seconds, that turn cannot rewind files; no snapshot is taken either when a file not covered by `.gitignore` is larger than 20MB or the snapshots exceed 1GB in total. Snapshots are deleted together with the container, so put large files in `.gitignore`). A rewind can itself be undone: it takes a "before rewind" snapshot first.
- **Changes per turn**: on the "Changes" page switch to "Per turn" to see which files a turn changed; when the working directory is not a git repository (for example quick chat) this is the default view.
- **Removing part of a conversation**: use "Rewind to here" with "Conversation only": that exchange and everything after it is deleted and the agent forgets it; files are left alone.

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

- Type `/` at the start to list the commands that work here, each with a one-line description. A new AGENT has them before its first message; commands handled by the web page itself work for every Agent, and Claude Code adds its own skills and built-in commands.
- Type `@` to list files in the working directory; picking one inserts its relative path.
- Use ↑↓ to choose, Enter or Tab to confirm, Esc to close.

## Handy Chat Features

All of these live around the input box and can also be triggered by typing `/command`. Web commands are handled as listed below; any other `/xxx` is sent to the Agent unchanged.

| Command | For | What it does |
|---|---|---|
| `/model` | all | Open the model menu |
| `/effort [level]` | Claude, Codex | Set reasoning effort; no argument opens the model menu |
| `/status` | all | Open Agent details |
| `/diff` | all | Show changes in the working directory |
| `/clear` | all | Create a new AGENT in this container |
| `/copy` | all | Copy the last reply |
| `/fork` | all | Fork a new AGENT from the latest point |
| `/btw <question>` | Claude, Codex | Side question: ask with context without interrupting the main task |
| `/recap` | Claude, Codex | One-line recap of where things stand |
| `/review` | all | Ask the AI to review uncommitted changes |
| `/plan` | Claude | Turn plan mode on or off |
| `/skills`, `/mcp` | Claude, Codex | See the container's skills and MCP servers |

- **Reasoning effort**: at the bottom of the model menu, listing only the levels the current model supports; "Default" uses the container's environment variables and config. It is hidden when the current model has no effort option or its options are unknown (for example Codex with a custom model). After switching models the level falls back to default if the new model does not support it. A level chosen here wins over `CLAUDE_CODE_EFFORT_LEVEL` set in the container's environment.
- **Context usage** (Claude Code only): a small readout next to the model menu such as "4.5k · 0%" (only the percentage on phones); open it to see usage and how much of the last request's input came from cache. After 5 minutes idle it says "the next message may need to re-cache (costs more)"; the cache lifetime of third-party services is unknown, so it only says "may". Updated once at the end of each turn.
- **Side question `/btw`**: the answer appears in a panel above the input box and is not saved to the conversation; the main task can keep running. Closing the panel cancels the question. One at a time per AGENT. Claude answers with the existing conversation as context and creates no session file.
- **Fork**: click the fork icon under one of your prompts, or type `/fork` (from the latest point); a dialog explains what it does and asks you to confirm. A new AGENT is created in the same container with the conversation before that turn, and that prompt is put in the new AGENT's input box; the original AGENT is unchanged and files are not copied (both share one directory). Claude forks precisely; other Agents start a new session from the remaining chat history. You cannot fork while a task is running.
- **Review changes**: the "Review changes" button in the Changes view toolbar, or `/review`. Claude uses its built-in `/code-review` if present, otherwise a fixed review prompt is sent; either way it is an ordinary turn. The button is disabled while a task runs or prompts are queued.
- **Plan mode** (Claude Code only): the "Plan mode" button in the input box (it turns dark and shows "Switched to plan mode" when on) or `/plan`; this turn only makes a plan and changes no files, and it turns itself off after one send. A "Run the plan" button appears under the reply. In plan mode Claude cannot show you multiple-choice questions (that tool does not exist in web chat); when it needs more information it asks in plain text.
- **Recap**: opening an AGENT that has been idle for 30 minutes shows a grey line "Recap: …" at the bottom of the chat, which you can close; `/recap` generates one on demand.
- **Skills and MCP**: top bar ⋯ → container group → "Skills and MCP", a read-only list of Claude Code and Codex skills and MCP server status in the container (Claude's MCP check really connects, so it may take a few seconds). The container cannot see host skills: mount the project directory (the project's `.claude/skills` is picked up automatically) or copy them to `~/.claude/skills/` in the container.
- **Automatic title**: after the first message, Claude Code and Codex use one cheap model call to write a short title; a remark or a `/rename` name wins. Tried once per AGENT, never retried on failure.
- **Tab title**: a `◐` prefix shows while the current conversation has a task running.

## Adding Prompts While a Task Runs

The input box stays enabled while an Agent is working. Once you type something, a "when to insert" button appears left of the send button; use it to choose when the new prompt takes effect (your last choice is remembered, and the placeholder shows the current choice):

- Insert now: interrupts the current round and continues right away with the new prompt (finished work is kept).
- Insert after the current step: waits for the current tool call or message to finish, then interrupts; if nothing finishes within 2 minutes it falls back to "insert now".
- Send after this round: queues the prompt and sends it automatically when the round ends (default).

Queued prompts appear at the bottom of the conversation and can be withdrawn (✕) or edited (✎). "Stop" only stops the current round: queued prompts are kept, and you can cancel them or click "Continue sending". Command mode does not support this.

Sub-agents and task lists show up in the "execution process": a sub-agent is collapsed into one line by default (click to see what it did), and the task list shows a single block with the latest status. While the agent is still working, what it is saying appears inside the execution process; the reply box shows up only when the turn ends, and it holds the final answer. The "align to bottom" button on the right keeps the bottom of that execution process pinned to the bottom of the window until you scroll yourself.

## Sessions, Changes and Notifications

- Session names: a remark wins, then a title the Agent set itself (`/rename`), then the automatic title generated after the first message (Claude Code, Codex), and finally the first message. Click the name in the top bar to rename; clear it to go back to the automatic name.
- Pinning: containers and AGENTs can both be pinned from their ⋯ menus. A pinned container goes to the top of the container list; pinning an AGENT only moves it to the top inside its container.
- Sorting: the ⇅ button in the sidebar sorts by name, creation time or modification time (default). On the container list it sorts containers; inside a container it sorts AGENTs; pinned items always stay first. The choice is remembered in the browser.
- The top-bar ⋯ menu is grouped by owner: chat belongs to the AGENT; files, terminal, changes, skills and MCP, and container settings belong to the container. "Changes" lists the changes in the git repository of the working directory; click a file to see its diff.
- Images in replies: when the Agent writes a Markdown image with a path inside the container (e.g. `![screenshot](/root/shot.png)`) it is shown directly. Absolute paths in replies can be clicked to open them in the Files view.
- Finished-task reminders: if a task ends while the page is in the background, the tab title gets a count such as `(1)`. Browser notifications can be turned on in "Settings → Page" (requires HTTPS or localhost).
- When you come back after a while, or the network recovers, the top bar shows sync progress and then "Synced".

New container: the default container name is `my-easy-{now}`, and the host and container directories are `{quickChatPath}/{now}` (`{now}` is `YYYYMMDD-HHmmss`, `{quickChatPath}` is the quick chat directory, or `~/.manyoyo/work` if unset); all three can be changed in "Settings → Basic". The directory is only created when you click "Create and enter".

Disk usage: removing a container does not remove its work directory on the host. "Settings → Maintenance → Disk usage" lists usage per directory, and work directories whose containers are gone or unused can be cleaned up there; your own project directories, directories pinned by a fixed `hostPath` in the config, and directories containing other mounted disks are never deleted. Each directory can be opened to see its files, and the page also lets you clean up conversation history left by deleted containers. The "empty directories whose container and history are both deleted" filter clears all empty directories in one click; when you delete a container from the sidebar with "delete together with history", its work directory is removed too if it sits inside the MANYOYO work directory and is empty.

When the web UI runs an Agent it adds a system prompt (replies are shown in a web page, how to write images). In "Settings → Agent → System prompt" you can turn off the default system prompt or add your own supplementary one (config field `agentInstructions`); they only set the initial content for containers created afterwards. You can edit it when creating a container, and later in the container's settings; existing containers are not affected by system settings.

## Export and Import

Move a container together with its conversations to another machine (or onto a newer image version on the same machine). Entry points: the download icon at the top of the sidebar (tooltip "Export / Import"; choose "Export container…" or "Import container…"), or "Export…" in a container's ⋯ menu. To keep chatting on a new machine, "Standard" is enough ("Light" also continues the chat but leaves the work directory behind).

**Export**: pick containers and a tier, then start.

| Tier | Contents |
|---|---|
| Light | Web chat history, Agent session records, container settings (env vars, autostart script, system prompt, network rules). Small; you can keep chatting after importing |
| Standard (recommended) | Light + chat images, Agent skills / MCP / settings / memory, and the host work directory |
| Full | Standard + software installed in the container and global packages, per-turn rewind snapshots. System-layer changes are only restored when the target has the same image version |
| Custom | Tick contents by hand; ticking exactly one tier's set highlights that tier |

- Caches, temp directories and mounted directories (extra mounts other than the work directory are only recorded as paths, never copied) are never exported.
- **Secrets are exported by default** (otherwise the new machine cannot chat right away). The file contains your API keys, so keep it safe; you can untick it: API keys, token-like env vars and each Agent's login credentials (e.g. Claude's `.credentials.json`, Codex's `auth.json`) are then left out, and you add the keys in "Container settings" and log in again after importing.
- Saving: **Direct download** (default) is received by the browser and uses no server disk, but keep the page open until it starts; **Save on server** writes to `~/.manyoyo/exports/`, lets you close the page, and uses server disk (free space is checked first).
- While exporting, the containers are paused (and restored afterwards); chat, terminal, files, settings and delete are unavailable for a moment. The sidebar card spins; click it to see progress or cancel. You cannot export while an AGENT is running.
- Compression: "Fast" (zstd 3, default) or "Smaller" (zstd 10, about 20% smaller, 4× slower). The file is `manyoyo-export-YYYYMMDD-HHmmss.tar.zst`; inspect it with `zstd -d` and `tar t`.

**Import**: "Export / Import → Import container…", choose a local file or one in `~/.manyoyo/exports/` (for large files `scp` them into that directory first to avoid reverse-proxy upload limits). Only the start of the file is read first to show a manifest; then confirm each container:

- The container name after import (duplicates are renamed automatically) and the local work directory (by default a sub-directory named after the new container inside the quick-chat directory; it must not exist yet or be empty). The host directory can be anything, but the **path inside the container stays the same** (the dialog shows it) so the Agent can keep its context.
- Image: "same as before" or "use this machine's default version".
- High-risk settings in the archive (sock / dind mode, extra mounts, port mappings, autostart script, env files, custom network rules) are off by default, and any image that is not a manyoyo image is replaced by this machine's default image and only apply if ticked; the `first` command is never run on import.
- When the import finishes the new container shows up in the sidebar (it is not opened automatically).
- The file is unpacked while it arrives, without a temporary copy; an interrupted upload, an incomplete file or a cancel automatically undoes the containers, directories and history created by this import.

**Migrating to a new image version**: export with "Standard" and choose "use this machine's default version" when importing. System-layer changes are left out; user data, Agent records, work directory and chat history all come along, and the container is rebuilt on the new image so you can keep chatting. Delete the old container yourself once you are happy.

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
