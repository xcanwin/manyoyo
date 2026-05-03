#!/usr/bin/env bash
set -euo pipefail

TARGETS="${MANYOYO_AGENT_UPDATE_TARGETS:-claude=@anthropic-ai/claude-code@latest codex=@openai/codex@latest}"

read -r -a agent_targets <<< "$TARGETS"

print_agent_versions() {
    for target in "${agent_targets[@]}"; do
        agent="${target%%=*}"
        if command -v "$agent" >/dev/null 2>&1; then
            printf "%s: " "$agent"
            "$agent" --version || echo "version check failed"
        else
            printf "%s: skipped (command not found)\n" "$agent"
        fi
    done
    printf "npm: "
    npm --version
}

update_packages=()
for target in "${agent_targets[@]}"; do
    agent="${target%%=*}"
    package_name="${target#*=}"
    if [ -n "$agent" ] && [ -n "$package_name" ] && [ "$agent" != "$package_name" ] && command -v "$agent" >/dev/null 2>&1; then
        update_packages+=("$package_name")
    fi
done

echo "[manyoyo] Agent CLI versions before update:"
print_agent_versions

if [ "${#update_packages[@]}" -gt 0 ]; then
    npm_config_update_notifier=false npm install -g npm@latest "${update_packages[@]}"
else
    echo "[manyoyo] No existing Agent CLI found; skip npm install."
fi

echo "[manyoyo] Agent CLI versions after update:"
print_agent_versions

npm_config_update_notifier=false npm cache clean --force --loglevel=error
rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* /var/tmp/* /var/tmp/.[!.]* /var/tmp/..?* /var/log/apt /var/log/*.log /var/lib/apt/lists/* ~/.npm ~/.cache/node-gyp ~/.claude/plugins/cache ~/go/pkg/mod/cache
rm -f /var/log/dpkg.log /var/log/bootstrap.log /var/lib/dpkg/status-old /var/cache/debconf/templates.dat-old
