#!/bin/sh
# 在 Xvfb 里跑有头浏览器服务，并用 x11vnc + noVNC 让用户在网页上观看
set -eu

export DISPLAY=:99
: "${VNC_PASSWORD:?VNC_PASSWORD is required}"

rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
i=0
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
done
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$VNC_PASSWORD" >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec node /run/manyoyo-playwright-vnc/playwright-server.js \
    /usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core \
    /run/manyoyo-playwright-vnc/server.json
