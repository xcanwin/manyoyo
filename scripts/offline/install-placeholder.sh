#!/bin/sh
# 安装逻辑由 T09 实现；这里只保证负载已通过 .run 头部的 SHA256 校验，并给出明确提示。
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
echo "MANYOYO 离线安装包校验通过，但安装逻辑尚未实现。"
echo "负载目录: $here"
[ -f "$here/manifest.json" ] && echo "清单: $here/manifest.json"
exit 1
