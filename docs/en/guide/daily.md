---
title: Daily Use | MANYOYO
description: Everyday MANYOYO operations covering start and stop, upgrade and rollback, uninstall, the private Podman and privacy notes.
---

# Daily Use

Start, stop, upgrade, roll back and uninstall are one command each. Use a new terminal first (or run `exec "$SHELL" -l` in the current one).

## Start

```bash
manyoyo
```

Starts (or reuses) the local web service and opens the browser, already signed in. The service keeps running in the background.

## Stop

```bash
manyoyo serve 127.0.0.1:<port> --stop     # the port is in the address printed at startup
```

## Upgrade and roll back

```bash
manyoyo update              # upgrade to the latest version
manyoyo update --rollback   # return to the previous version
```

An upgrade downloads only what changed, tens of MB.

## Uninstall

```bash
manyoyo uninstall
```

Only the program itself is removed; config, session history, logs and the work directory are asked about one by one and kept by default. `--yes` only confirms removing the program and never deletes user data. When you reuse your own Docker / Podman it only asks whether to delete manyoyo's containers and images, never the runtime itself.

## Manage the private Podman

The macOS package uses MANYOYO's bundled private Podman, which the system `podman` command cannot see:

```bash
manyoyo podman ps -a                 # run once
eval "$(manyoyo podman env)"         # from now on in this terminal: podman ps -a, podman logs ...
```

The function only lives in the current terminal.

## Privacy

The installer and the version check **collect and upload nothing**: `serve` asks GitHub Releases for a newer version at most once a day with a fixed `User-Agent` and no local information, which you can turn off with `"updateCheck": false` in the global config. Your keys stay in `~/.manyoyo/manyoyo.json` on your machine.

## Next Steps

- [Command Cheat Sheet](../reference/cli-options.md)
- [Run Agents from the Command Line](./basic-usage.md)
- [FAQ](../troubleshooting/README.md)
