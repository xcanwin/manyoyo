---
title: Web Server Auth and Security | MANYOYO
description: Covers auth gateway behavior, priority rules, login flow, and exposure hardening for MANYOYO serve mode.
---

# Web Server Auth and Security

This page focuses on authentication behavior and minimum security baseline for `manyoyo serve`.

The web UI provides three interaction modes: `Command`, `AGENT`, and `Interactive Terminal`. `AGENT` mode requires `agentPromptCommand` to be configured on the session (template must include `{prompt}`).

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

- `/auth/login`
- `/auth/logout`
- `/auth/frontend/login.css`
- `/auth/frontend/login.js`
- `/shadcn/auth/login` (the default shadcn/ui frontend login page)

## Default shadcn/ui Frontend

`serve` mode uses the shadcn/ui frontend by default. The legacy static frontend remains available at `/legacy` as a fallback.

- Default URL: `http://127.0.0.1:3000/`; `/shadcn` is a compatibility alias. When unauthenticated, either route redirects to `http://127.0.0.1:3000/shadcn/auth/login`, then back to `/shadcn` after a successful login
- Legacy frontend URL: `http://127.0.0.1:3000/legacy`
- The login page reuses the same `/auth/login` endpoint and cookie as the existing frontend, so there's no separate account
- Source lives in `frontend-shadcn/` at the repo root, a standalone Vite + React + TypeScript project. It uses ES Modules; the rest of the Node project still follows CommonJS conventions

Before working on it for the first time, install its own dependencies separately (it's a large, separate tree that won't slow down everyday `npm install`):

```bash
cd frontend-shadcn && npm ci && cd ..
```

Then, depending on what you need:

```bash
# Just want to see the current build: build once, then preview via my serve as usual
npm run build:web-shadcn
manyoyo serve

# Editing frontend-shadcn/src and want live reload (HMR) — two terminals:
manyoyo serve                # Terminal 1: the real backend (containers, sessions, terminal WebSocket)
npm run dev:web-shadcn       # Terminal 2: Vite dev server, proxies /api and /auth to 127.0.0.1:3000 by default
```

If `my serve` listens on an address other than the default `127.0.0.1:3000`, override the proxy target for `dev:web-shadcn` with the `MANYOYO_SERVE_URL` environment variable.

On publish (`npm publish`/`npm pack`), `frontend-shadcn` is rebuilt automatically and the output is baked into `lib/web/frontend/shadcn.html`; running `my serve` in production needs no frontend toolchain beyond Node itself.

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
