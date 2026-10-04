#!/bin/sh
# 按需启动 Xvfb 与轻量窗口管理器（多个会话共用 :99），浏览器以有头模式跑在虚拟屏里。
# 以 playwright-cli 名字调用时交给 @playwright/cli；以 playwright-mcp 名字调用时启动 stdio MCP（读同一份 $PLAYWRIGHT_MCP_CONFIG）。
export DISPLAY=:99
CONFIG="${PLAYWRIGHT_MCP_CONFIG:-/run/manyoyo-playwright/config.json}"
# 浏览器在容器外（headed / chrome / vnc）时不需要虚拟屏
if ! grep -qE '"(remoteEndpoint|cdpEndpoint)"' "$CONFIG" 2>/dev/null; then
    # 以锁文件里的进程是否活着为准；容器被 kill 后遗留的 socket 与锁文件要清掉
    if ! kill -0 "$(cat /tmp/.X99-lock 2>/dev/null)" 2>/dev/null; then
        rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
        setsid Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
        i=0
        while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
            sleep 0.1
            i=$((i + 1))
        done
        # 窗口管理器让窗口有真实的外框与工作区（screen.availHeight < height），不再是裸 X 屏
        setsid fluxbox >/dev/null 2>&1 &
        sleep 0.5
    fi
fi
PACKAGE=/usr/local/lib/node_modules/@playwright/cli
if [ "$(basename "$0")" = "playwright-mcp" ]; then
    exec node "$PACKAGE/node_modules/playwright-core/cli.js" mcp --config "$CONFIG" "$@"
fi
exec node "$PACKAGE/playwright-cli.js" "$@"
