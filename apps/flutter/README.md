# MANYOYO Flutter

当前目录已经初始化为 Flutter 多端工程，目标平台包括：

- macOS
- Windows
- iOS
- Android

当前阶段定位：

- 这是 `Flutter` 分支的独立客户端骨架。
- 先验证跨平台工程可维护性，再决定是否接入 MANYOYO 的 Web 或服务端能力。
- 不在仓库根目录创建 Flutter 平台目录，所有平台工程都固定在 `apps/flutter/` 下。

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
flutter run -d macos --dart-define=MANYOYO_SERVER_URL=http://127.0.0.1:3000
```

说明：

- Flutter 端当前先走“地址输入/保存 + 检测连接 + 系统浏览器打开 MANYOYO”方案，避免过早锁定 WebView 技术选型。
- `127.0.0.1` 仅适用于当前机器本地运行；真机或其他设备需替换为宿主机可访问地址。
- 地址会保存在本地偏好设置中，后续启动可直接复用。

下一步建议：

1. 明确 Flutter 端是 WebView 壳还是原生客户端。
2. 设计登录、会话和 manyoyo 服务接入方式。
3. 再补路由、状态管理和网络层。
