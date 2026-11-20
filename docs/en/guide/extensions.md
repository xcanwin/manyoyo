---
title: Shared Skills and MCP
description: Maintain one set of skills and MCP servers on the host; new containers get them automatically and existing ones can sync on demand.
---

# Shared skills and MCP

Maintain skills and MCP servers on the host once, have new containers pick them up automatically, and sync existing containers on demand. Entry: top bar ⋯ → container group → "Skills and MCP".

## Where the shared library lives

```
~/.manyoyo/extensions/
  skills/
    common/<name>/SKILL.md    # used by both Claude and Codex
    claude/<name>/SKILL.md    # Claude only
    codex/<name>/SKILL.md     # Codex only
  mcp.json                    # shared MCP definitions (contains secrets, mode 0600)
```

Deleting a container does not delete the shared library. The library only manages entries it created; skills and MCP servers added manually inside a container are never overwritten or removed.

## New and existing containers

- New containers: the whole `skills/` directory is mounted read-only and links are created in the container home, so later library updates are visible immediately. Containers cannot modify the shared files.
- Existing containers (created before the library existed): click "Sync to this container" to copy the content; re-sync after the library changes.
- Same-named directories or MCP servers that the library does not manage are skipped and reported as conflicts, never overwritten. Copy mode uses the `.manyoyo-managed` marker inside the skill directory to recognize its own copies; if the marker is missing or the hash does not match (for example, you replaced it with your own directory), it is kept and reported as a conflict.

## Secrets and trust boundaries

- **Shared skills are code**: every Agent reads them, and scripts or instructions inside can influence Agent behavior. Only add content you trust.
- **Shared MCP secrets are visible to every container that uses them**: `env` / `headers` from `mcp.json` are delivered to each container and readable by the Agent there. Leaving a value empty while editing keeps the current value; the UI and API only show the key and its last 4 characters.
- **MCP commands run inside the container** and are subject to its network policy. If a server needs a domain, allow it in the network rules as well; a network failure is not a configuration error.
- **Project-level configuration is not trusted automatically**: `.mcp.json` and `.claude/skills` in the working directory come from the repository. The UI marks them as "project-provided"; you must confirm them in the container. They are never auto-approved or copied into the shared library.

## Claude vs Codex

- stdio works for both; SSE is Claude-only; Codex HTTP does not support custom headers, use `bearerTokenEnvVar` (only the variable name is stored; set the value in the container env).
- Connection test: Claude really connects (up to ~30 seconds); Codex can only confirm "configured" and does not test the connection.
- MCP OAuth login is not managed by MANYOYO. When login is needed, run the Agent's own login command in the container terminal.

## Export and import

The shared library itself is not inside the container and is not exported. Managed links in mount mode are skipped on export; copies made in copy mode are part of the container home and are exported. MCP configuration delivered to a container may contain secrets, which are cleared field by field on export.
