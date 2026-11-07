"""列出本机仍在运行的 Claude 会话：会话名（会变）↔ 对话 ID（--resume 用，不变）↔ 进程号。
用法：python3 .claude/skills/plan-handoff/scripts/peers.py [对话ID前缀]
消息里 from="uds:/run/user/<uid>/cc-socks/<进程号>.sock" 的进程号可以在这里对上对话 ID。"""
import json, os, sys
from pathlib import Path

want = sys.argv[1] if len(sys.argv) > 1 else ""
for f in sorted((Path.home() / ".claude" / "sessions").glob("*.json")):
    try:
        d = json.loads(f.read_text())
    except Exception:
        continue
    pid = d.get("pid")
    try:  # 进程号可能被别的程序复用：命令行里必须是 claude
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="ignore")
    except OSError:
        continue  # 进程已退出
    if "claude" not in cmd:
        continue
    if want and not d.get("sessionId", "").startswith(want):
        continue
    print(f"{d.get('name', '?'):12} 对话ID={d.get('sessionId')} 进程={pid} 状态={d.get('status', '?')} 目录={d.get('cwd')}")
