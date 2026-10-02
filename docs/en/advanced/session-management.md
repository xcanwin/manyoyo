# Session Management

This page explains how to create, resume, keep, and clean up container sessions. A session is one container plus the agent's working state and conversation history inside it.

> Put run profiles in `runs.<name>` of `~/.manyoyo/manyoyo.json`; use absolute paths for `envFile` and an object for `env`.

## Create a Session

```bash
# Named session (recommended, easy to resume)
manyoyo run -n my-project -y c

# Without a name, one is generated as my-{MMDD}-{HHmm}; see it with manyoyo ps
manyoyo run -y c

# Fix name and options with a run profile
manyoyo run -r project-a
```

```json
{
    "runs": {
        "project-a": {
            "containerName": "my-project-a",
            "hostPath": "/abs/path/project-a",
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

`containerName` supports the `{now}` template (expands to `MMDD-HHmm`).

## Choices on Exit

After the agent exits, MANYOYO asks whether to keep the container:

| Option | Effect |
|--------|--------|
| `y` (default) | Keep the container in the background to resume later |
| `n` | Delete the container; data and history are lost |
| `1` | Re-enter with the first command (container label `manyoyo.default_cmd`) |
| `r` | Append the resume argument to the first command (only shown when it is an agent) |
| `x` | Enter and run a new command |
| `i` | Open an interactive shell |

To hide the prompt use the `-q` quiet items (see [CLI Options](../reference/cli-options.md)); for one-off tasks use `--rm-on-exit` to delete on exit:

```bash
manyoyo run -n temp --rm-on-exit -y c
```

## Resume a Session

While the container exists, re-enter it by name; arguments after `--` are appended to the first command:

```bash
manyoyo run -n my-project              # run the first command again
manyoyo run -n my-project -- -r        # Claude / Gemini resume
manyoyo run -n my-project -- resume    # Codex resume
manyoyo run -n my-project -- -c        # OpenCode resume
```

Resume arguments follow `lib/agent-resume.js`: Claude/Gemini -> `-r`, Codex -> `resume`, OpenCode -> `-c`. The terminal hint after startup also prints the resume command for the current container. For more resume options see each agent's own `--help`.

## What Persists

- **While the container exists**: filesystem, environment variables, and agent history stay in the container; `manyoyo rm` removes all of it.
- **Working directory**: the current directory is mounted by default; use `--hp` for another one. Code changes live on the host.
- **Extra data**: mount with `-v` or `volumes`; named volumes survive container deletion.
- **Conversation history**: stored inside the container (for example `~/.claude`, `~/.codex`). To keep it after deleting the container, mount that directory; for the risk of mounting host credentials or config directories see [Security Notes](../guide/security.md).

```bash
manyoyo run -n my-project -v "myproject-data:/workspace/data" -y c
```

## Multiple Sessions

Each session has its own filesystem, environment, history, and processes. Use one per project:

```bash
manyoyo run -n project-a --hp ~/projects/a -y c
manyoyo run -n project-b --hp ~/projects/b -y c
manyoyo ps                          # list all sessions
manyoyo run -n project-a -- -r      # back to A (Claude)
```

## Inspect and Enter

```bash
manyoyo ps                                  # list sessions
manyoyo run -n my-project -x /bin/bash      # enter a running container
docker logs --tail 100 my-project           # container logs (same for Podman)
```

## Clean Up

Run `manyoyo ps` to confirm the name, then delete one by one. Avoid prefix-matching batch commands, which can remove unrelated containers:

```bash
manyoyo ps
manyoyo rm <name>
```

## Backup and Snapshot

```bash
docker cp my-project:/root/.claude ./claude-backup    # back up agent history
docker commit my-project my-project:snapshot          # save current state as an image
```

Snapshot images are not managed by `manyoyo`; list them with `manyoyo images` and remove them when no longer needed.

## Troubleshooting

- **Container does not exist**: confirm the name with `manyoyo ps`; if deleted, run `manyoyo run -n <name> -y c` again.
- **Agent forgets earlier conversation**: the container may be new, or the history directory was not mounted; see What Persists.
- **Container fails to start**: check `docker logs <name>`, and if needed `manyoyo rm <name>` then recreate; for runtime problems see [Runtime Errors](../troubleshooting/runtime-errors.md).

## Next Steps

- [Basic Usage](../guide/basic-usage.md)
- [AI Agents](../reference/agents.md)
- [Security Notes](../guide/security.md)
