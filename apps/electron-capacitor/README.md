# MANYOYO Electron-Capacitor

当前目录承接 `Electron-Capacitor` 分支的应用级说明。

- `electron/`: Electron 桌面壳
- `capacitor/`: 共享 Web 壳与移动端说明
- `android/`: Android 原生工程
- `ios/`: iOS 原生工程

桌面端最简入口：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install
npm run electron:dev
```

桌面端如需联动本地 MANYOYO 服务：

```bash
MANYOYO_DESKTOP_AUTO_SERVE=1 npm run electron:dev
```

移动端常用入口：

```bash
MANYOYO_CAP_SERVER_URL=http://127.0.0.1:3000 npm run capacitor:add:ios
MANYOYO_CAP_SERVER_URL=http://127.0.0.1:3000 npm run capacitor:open:ios

MANYOYO_CAP_SERVER_URL=http://127.0.0.1:3000 npm run capacitor:add:android
MANYOYO_CAP_SERVER_URL=http://127.0.0.1:3000 npm run capacitor:open:android
```

移动端细节说明见 [capacitor/README.md](capacitor/README.md)。
