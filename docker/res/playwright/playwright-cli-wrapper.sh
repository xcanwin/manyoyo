#!/usr/bin/env sh
set -eu

PLAYWRIGHT_NODE_BIN="${PLAYWRIGHT_NODE_BIN:-node}"
PLAYWRIGHT_CLI_ROOT="/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright"
PLAYWRIGHT_CLI_PROGRAM="${PLAYWRIGHT_CLI_ROOT}/lib/cli/client/program.js"
PLAYWRIGHT_REAL_CLI="${PLAYWRIGHT_CLI_ROOT}/cli.js"

resolve_browser() {
    browser=""

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --browser=*)
                browser="${1#--browser=}"
                ;;
            --browser)
                shift
                if [ "$#" -gt 0 ]; then
                    browser="$1"
                    shift
                fi
                continue
                ;;
            --)
                break
                ;;
            -*)
                ;;
            *)
                if [ -z "$browser" ]; then
                    browser="$1"
                fi
                ;;
        esac
        shift
    done

    if [ -n "$browser" ]; then
        printf '%s\n' "$browser"
        return 0
    fi

    "$PLAYWRIGHT_NODE_BIN" <<'NODE'
const fs = require('fs');
const path = require('path');

const candidates = [
    process.env.PLAYWRIGHT_MCP_CONFIG,
    path.resolve('.playwright/cli.config.json')
].filter(Boolean);

for (const filePath of candidates) {
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const browser = config && config.browser ? config.browser : {};
        const launchOptions = browser.launchOptions || {};
        const channel = String(launchOptions.channel || browser.browserName || '').trim();
        if (channel) {
            process.stdout.write(channel);
            process.exit(0);
        }
    } catch (_) {}
}

process.stdout.write('chromium');
NODE
}

if [ "${1-}" = "install-browser" ]; then
    shift
    for arg in "$@"; do
        if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
            exec "$PLAYWRIGHT_NODE_BIN" "$PLAYWRIGHT_CLI_PROGRAM" install-browser "$@"
        fi
    done

    BROWSER="$(resolve_browser "$@")"
    exec "$PLAYWRIGHT_NODE_BIN" "$PLAYWRIGHT_REAL_CLI" install "$BROWSER"
fi

exec "$PLAYWRIGHT_NODE_BIN" "$PLAYWRIGHT_CLI_PROGRAM" "$@"
