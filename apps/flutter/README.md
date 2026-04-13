# MANYOYO Flutter

当前 `apps/flutter/` 已切换为纯 Flutter 原生客户端：

- 不再内嵌 MANYOYO WebView。
- 目标平台仍为 `macOS`、`Windows`、`iOS`、`Android`。
- Flutter 端直接消费 MANYOYO `serve` 提供的认证、会话、消息流、文件、终端、配置接口。

当前原生 UI 已覆盖的主链路：

- 服务地址 + 用户名/密码登录
- 会话列表与会话详情
- AGENT 流式消息发送 / 停止
- 文件浏览、文本文件读取与保存
- 基础终端连接与输入输出
- 配置文件查看与保存

常用命令：

```bash
cd apps/flutter
flutter pub get
flutter analyze
flutter test
flutter run -d macos
```

连接 MANYOYO：

```bash
manyoyo serve 127.0.0.1:3000 -U demo -P demo123
cd apps/flutter
flutter run -d macos
```

说明：

- Flutter 客户端通过 MANYOYO 的 Cookie 认证访问 `/api/*` 与终端 WebSocket。
- 纯原生方案下，不再提供“进入内置 MANYOYO WebView”或“外部浏览器兜底”路径。
- 若服务端返回 `401`，客户端会回到登录页重新鉴权。
- 文件编辑当前仅支持文本文件；终端当前为基础原生终端视图，优先保证会话、文件与命令输入输出链路稳定。
