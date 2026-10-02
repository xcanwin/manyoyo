---
title: "Containers Inside the Sandbox | MANYOYO"
description: "Let an AI agent build images and run containers inside the MANYOYO sandbox with dind or sock, with minimal steps and common problems."
---

# Running Containers Inside the Sandbox (dind / sock)

Let an AI agent build images and run containers inside the sandbox: `dind` uses an independent runtime inside the container, while `sock` operates the host Docker directly. Both modes add `--privileged`; see [Security](../guide/security.md) for the risks and [Container Modes](../reference/container-modes.md) for the comparison.

## dind: independent runtime inside the container (recommended)

```bash
manyoyo run -m dind -x /bin/bash
```

Use Podman directly once inside:

```bash
podman ps -a
podman run hello-world
podman build -t myimage .
```

To use Docker, start `dockerd` manually first:

```bash
nohup dockerd > /var/log/dockerd.log 2>&1 &
sleep 10
docker ps -a
```

Nested images and containers live inside the outer container, so removing it removes them all. Mount any important data into the outer container.

### Save as a run profile

```json5
// ~/.manyoyo/manyoyo.json
{
    "runs": {
        "dind": {
            "containerName": "my-dind",
            "containerMode": "dind",
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

```bash
manyoyo run -r dind
```

### Example: let the agent edit a Dockerfile and verify it

```bash
manyoyo run -r dind
# Ask the agent to write a Dockerfile, then build and run it:
podman build -t myapp:test .
podman run --rm myapp:test npm test
```

After exiting, use `manyoyo run -n my-dind -x /bin/bash` to return to the same container and check `podman ps -a` and `podman images`.

## sock: mount the host Docker socket

```bash
manyoyo run -m sock -x /bin/bash
docker ps
```

`sock` mounts `/var/run/docker.sock` and sets `DOCKER_HOST` and `CONTAINER_HOST`. The container sees the host's containers and images, and its actions take effect on the host directly. Use it only for fully trusted tasks.

## Troubleshooting

**`dockerd` fails to start**: check `/var/log/dockerd.log`, or run `dockerd --debug` in the foreground; remove a stale `/var/run/docker.sock` and retry.

**Podman permission errors**: run `podman info` to check storage and namespaces; if needed, `podman system reset` (this wipes nested containers and images).

**Image pull fails**: confirm network access inside the container first; for a proxy, pass `HTTP_PROXY` / `HTTPS_PROXY` through `env`, or configure a mirror in `/etc/containers/registries.conf`.

**Out of space**: check usage with `podman system df`, clean up with `podman system prune -a --volumes`.

## Notes

- Nested containers have some performance overhead, and the separate image store uses extra disk.
- The outer container's resource limits also limit nested containers.
- Nested container ports must be published to the outer container before they are reachable from the host.
- Not recommended for production; use a dedicated runtime or a daemonless tool such as Kaniko for production builds.

## Next steps

- [Container Modes](../reference/container-modes.md)
- [Security](../guide/security.md)
- [Runtime Errors](../troubleshooting/runtime-errors.md)
