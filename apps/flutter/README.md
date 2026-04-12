# MANYOYO Flutter

当前目录已经初始化为 Flutter 多端工程，目标平台包括：

- macOS
- Windows
- iOS
- Android

当前阶段定位：

- 这是 `Flutter` 分支的独立客户端骨架。
- Flutter 端当前正式走“内嵌 MANYOYO Web 应用”的宿主壳方案，以便与 `main` 分支现有 Web 功能保持一致。
- 不在仓库根目录创建 Flutter 平台目录，所有平台工程都固定在 `apps/flutter/` 下。

常用命令：

```bash
cd apps/flutter
flutter pub get
flutter analyze
flutter test
flutter run -d macos
```

Flutter SDK 约定：

- 仓库内固定复用仓库根目录下的 `temp/tools/flutter-sdk-3.41.6`，不再维护 `temp/tools/flutter-sdk` 这一层软链。
- 若容器或本地环境重置后 `flutter` / `dart` 命令丢失，在仓库根目录执行以下命令恢复到 `/usr/local/bin/`：

```bash
ln -sfn "$(pwd)/temp/tools/flutter-sdk-3.41.6/bin/flutter" /usr/local/bin/flutter
ln -sfn "$(pwd)/temp/tools/flutter-sdk-3.41.6/bin/dart" /usr/local/bin/dart
```

- 若在 root 容器里执行 Flutter 命令，建议固定 `PUB_CACHE` 与 `HOME`，避免首次启动锁或分析统计干扰：

```bash
CI=true FLUTTER_SUPPRESS_ANALYTICS=true \
PUB_CACHE="$(git rev-parse --show-toplevel)/temp/tools/pub-cache" \
HOME="$(git rev-parse --show-toplevel)/temp" \
flutter test
```

桌面端默认只启动客户端；如需恢复“本地服务 + 客户端”联动模式，可在启动前设置：

```bash
MANYOYO_DESKTOP_AUTO_SERVE=1 flutter run -d macos
MANYOYO_DESKTOP_AUTO_SERVE=1 flutter run -d windows
```

连接 MANYOYO：

```bash
flutter run -d macos --dart-define=MANYOYO_SERVER_URL=http://127.0.0.1:3000
```

iOS 真机补充：

- `flutter run -d ios` 不是固定可用写法，先执行 `flutter devices`，再使用实际设备 ID，例如 `flutter run -d 00008101-001568102E60001E`。
- 若 Xcode/Flutter 提示 `Runner.app is not a valid bundle`、`CFBundleExecutable` 或安装阶段使用了残缺的 `build/ios/iphoneos/Runner.app`，先执行：

```bash
flutter clean
rm -rf build/ios
cd ios && pod install && cd ..
flutter run -d <device-id>
```

说明：

- Flutter 端当前支持“地址输入/保存 + 检测连接 + 内置 MANYOYO WebView + 外部浏览器打开”。
- `127.0.0.1` 仅适用于当前机器本地运行；真机或其他设备需替换为宿主机可访问地址。
- 地址会保存在本地偏好设置中，后续启动可直接复用。
- 启动页会展示当前连接阶段，并提供“填入本机地址 → 检测连接 → 进入 MANYOYO”的推荐流程。
- macOS 已补出站网络权限，允许沙箱内应用访问本机或局域网 MANYOYO 服务。
- 通过 `flutter_inappwebview` 直接承接 MANYOYO 登录页与主界面；Windows 端需本机具备 NuGet CLI 与 WebView2 运行环境。

下一步建议：

1. 明确内置 WebView 下的登录态、登出与错误页体验。
2. 决定哪些能力继续复用 Web，哪些需要 Flutter 原生承接。
3. 再补原生通知、文件选择、分享等宿主能力。
