---
title: Web Server Auth and Security | MANYOYO
description: Covers auth gateway behavior, priority rules, login flow, and exposure hardening for MANYOYO serve mode.
---

# Web Server Auth and Security

This page focuses on authentication behavior and minimum security baseline for `manyoyo serve`.

## Listen Address and Startup

`serve` supports:

- `<port>`, e.g. `3000`
- `<host:port>`, e.g. `127.0.0.1:3000`, `0.0.0.0:3000`

Default listen address is `127.0.0.1:3000`.

```bash
# Local access only (default)
manyoyo serve

# Custom port
manyoyo serve 3000

# LAN access (requires strong password + firewall)
manyoyo serve 0.0.0.0:3000 -u admin -P 'StrongPassword'
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
2. Ensure `-u` / `-P` matches effective config
3. Run `manyoyo config show` and verify final source of `serverUser` / `serverPass`

## Related Docs

- [CLI Reference](../reference/cli-options.md)
- [Configuration Overview](../configuration/README.md)
- [Configuration Files Details](../configuration/config-files.md)
