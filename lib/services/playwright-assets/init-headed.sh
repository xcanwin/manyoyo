#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:99

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
fluxbox >/tmp/fluxbox.log 2>&1 &

if [[ -z "${VNC_PASSWORD:-}" ]]; then
    echo "VNC_PASSWORD is required."
    exit 1
fi

x11vnc -display :99 -forever -shared -rfbport 5900 -localhost -passwd "$VNC_PASSWORD" >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec "$@"
