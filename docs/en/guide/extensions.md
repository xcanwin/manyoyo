---
title: Shared Skills and MCP
description: Keep one set of skills and MCP servers on the host; new containers get them automatically and existing ones can sync when needed.
---

# Shared skills and MCP

Keep skills and MCP servers on the host once. New containers get them automatically, and existing containers can sync when needed. Entry: top bar ⋯ → container group → "Skills and MCP".

## Where the shared library lives

```
~/.manyoyo/extensions/
  skills/
    common/<name>/SKILL.md    # used by both Claude and Codex
    claude/<name>/SKILL.md    # Claude only
    codex/<name>/SKILL.md     # Codex only
  mcp.json                    # shared MCP definitions (contains secrets, mode 0600)
```

Deleting a container does not delete the shared library. The library only manages entries it added; skills and MCP servers added by hand inside a container are never overwritten or removed.

## New and existing containers

- New containers: the whole `skills/` directory is mounted read-only and links are created in the container home, so later library changes are visible right away. Containers cannot change the shared files.
- Existing containers (created before the library existed): click "Sync to this container" to copy the content; sync again after the library changes.
- Same-named directories or MCP servers that the library did not add are skipped and shown as conflicts; they are never overwritten. In copy mode the library writes a `.manyoyo-managed` marker file in each skill directory it copies. On sync it only deletes copies whose marker exists and whose content checksum matches. If the marker is missing or does not match (for example, you replaced the directory with your own), it keeps the directory and reports a conflict. Other files in a skill directory have the same 1 MB per file / 20 MB per skill limit. A skill that is too large or contains symlinks is skipped as a whole (shown as "over size limit"), is not checksummed, and is not synced, so large files cannot slow down the extensions list.

## Secrets and safety

- **Shared skills are code**: every Agent reads them, and scripts or instructions inside can affect Agent behavior. Only add content you trust.
- **Shared MCP secrets are visible to every container that uses them**: `env` / `headers` from `mcp.json` are sent to each container and can be read by the Agent there. Leaving a value empty while editing keeps the current value; the UI and API only show the key and the last 4 characters.
- **MCP commands run inside the container** and are limited by its network rules. If a server needs a domain, allow it in the network rules too; a network failure is not an MCP configuration error.
- **Project configuration is not enabled automatically**: `.mcp.json` and `.claude/skills` in the working directory come from the repository. The UI marks them as "project-provided"; you must confirm them in the container. They are never approved automatically and are never added to the shared library.

## Claude vs Codex

- stdio works for both; SSE is Claude-only; Codex HTTP does not support custom headers, so use `bearerTokenEnvVar` (only the variable name is stored; set the value in the container env).
- Connection test: Claude really connects (up to about 30 seconds); Codex can only confirm "configured" and does not test the connection.
- MCP OAuth login is not managed by MANYOYO. When login is needed, run the Agent's own login command in the container terminal.

## Export and import

The shared library itself is not inside the container and is not exported. Links created by the read-only mount are skipped on export. Copies made in copy mode are part of the container home and are exported. MCP configuration already sent to a container may contain secrets; those fields are cleared on export.
