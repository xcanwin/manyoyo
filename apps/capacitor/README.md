# MANYOYO Capacitor

这个目录用于 `iOS / Android` 移动端壳。

当前方案不是在手机里运行 manyoyo 的 Node 服务，而是直接加载远程 `manyoyo serve`：

1. 在宿主机或服务器启动 `manyoyo serve`
2. 构建 Capacitor 配置，把远程 MANYOYO Web 地址写入 App
3. 移动端继续复用同一套 `lib/web/frontend/` 前端核心

## 生成配置

```bash
MANYOYO_CAP_SERVER_URL=https://your-manyoyo.example.com npm run capacitor:config
```

开发期也可以用局域网 HTTP：

```bash
MANYOYO_CAP_SERVER_URL=http://192.168.1.10:3000 npm run capacitor:config
```

## 常用命令

```bash
npm run capacitor:add:ios
npm run capacitor:add:android
npm run capacitor:sync
```

## 说明

- 未设置 `MANYOYO_CAP_SERVER_URL` 时，App 会加载本地说明页。
- 移动端 manyoyo Web 会自动复用 `window.Capacitor` 来打开外链。
- 正式环境建议使用 HTTPS 反向代理，而不是直接暴露局域网 HTTP。
