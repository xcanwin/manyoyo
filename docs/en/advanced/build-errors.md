# Build Issue Troubleshooting

Find the cause and the shortest fix by error message. The default image `ghcr.io/xcanwin/manyoyo` is pulled automatically; you only need to build for a [custom image](./custom-image.md). Examples use `2.1.0-common`; replace with your actual tag.

## General Build Failure Checklist

Save the log first, then match the symptoms below:

```bash
manyoyo build --iv 2.1.0-common 2>&1 | tee build.log
grep -i "error\|failed\|fatal" build.log
```

If the cause is still unclear, build the slim variant to verify the basics, then build the full one:

```bash
manyoyo build --iv 2.1.0-common --iba TOOL=common
manyoyo build --iv 2.1.0-full --iba TOOL=full
```

## Image Pull Failures

```text
Error: pinging container registry localhost failed
```

Cause: the image is not present locally and the registry is unreachable (network, proxy, or a tag that does not exist).

```bash
# List local tags
docker images | grep manyoyo  # or podman images

# Use an existing tag
manyoyo run --iv <x.y.z-suffix> -y c

# Or build locally
manyoyo build --iv 2.1.0-common
```

To pin a tag permanently, set `"imageVersion": "2.1.0-common"` in `~/.manyoyo/manyoyo.json`.

## Network Issues

```text
Error: unable to download from https://...
Error: connection timeout
```

Cause: mirrors are unreachable, DNS fails, or a proxy is required.

```bash
# Connectivity and proxy
curl -I https://mirrors.tencent.com
echo $HTTP_PROXY $HTTPS_PROXY

# DNS
nslookup mirrors.tencent.com
```

- **Proxy**: for Docker, set `httpProxy` / `httpsProxy` / `noProxy` under `proxies.default` in `~/.docker/config.json`; for Podman, export `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and rebuild.
- **DNS**: for Docker, set `"dns": ["8.8.8.8"]` in `/etc/docker/daemon.json`; for Podman, set `dns_servers = ["8.8.8.8"]` under `[containers]` in `~/.config/containers/containers.conf`; then restart the service.
- **Firewall (firewalld)**: `sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0 && sudo firewall-cmd --reload` (use `cni-podman0` for Podman).
- **Outside China**: the default mirrors are Chinese sites; blank them to use official sources:

```bash
manyoyo build --iv 2.1.0-common --iba NODEJS_MIRROR= --iba NPM_REGISTRY= --iba PIP_INDEX_URL=
```

- **Git SSL verification failure** (development only): `--iba GIT_SSL_NO_VERIFY=true`.
- **Download timeouts**: downloads are cached in `docker/cache/` (valid for 2 days), so a retry usually skips what is already fetched.

## Disk Space Issues

```text
Error: no space left on device
```

Cause: a build needs roughly 10GB of free space.

```bash
df -h
docker system df  # or podman system df

manyoyo prune                # remove dangling and <none> images
docker builder prune -a      # clear the build cache
rm -rf docker/cache/         # clear the MANYOYO download cache (re-downloaded next build)
```

Avoid `docker system prune -a` unless you mean it: it removes all unused images and stopped containers. If the system disk is too small, move the data directory: set `"data-root"` in `/etc/docker/daemon.json` for Docker, or `graphroot` under `[storage]` in `~/.config/containers/storage.conf` for Podman.

## Permission Issues

```text
Error: permission denied while trying to connect to the Docker daemon socket
```

Cause: the current user is not in the `docker` group.

```bash
sudo usermod -aG docker $USER
newgrp docker
docker ps
```


## Platform Issues

- **Windows WSL2**: make sure Docker Desktop uses the WSL2 backend with integration enabled for your distro (`docker version` must connect), or install native Docker / Podman inside WSL.

## Cache Issues

The cache directory `docker/cache/` (Node.js, JDT LSP, gopls) is valid for 2 days.

- **Corrupted cache, extraction or checksum errors during build**: run `rm -rf docker/cache/` and rebuild.
- **Cache not used**: files listed by `find docker/cache/ -type f -mtime +2` have expired and will be downloaded again.

## Need More Detailed Output

Build manually with full output:

```bash
podman build -t ghcr.io/xcanwin/manyoyo:test-full \
    -f docker/manyoyo.Dockerfile . \
    --build-arg TOOL=full --no-cache --progress=plain
```

## Next Steps

- [Custom Image](./custom-image.md): build arguments and caching
- [Runtime Issues](../troubleshooting/runtime-errors.md): errors at container run time
- [Troubleshooting Home](../troubleshooting/README.md)
