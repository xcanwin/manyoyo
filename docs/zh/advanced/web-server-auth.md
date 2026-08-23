---
title: 网页服务认证与安全实践 | MANYOYO
description: 介绍 MANYOYO serve 模式的认证网关、参数优先级、登录流程与对外监听安全建议。
---

# 网页服务认证与安全实践

本页聚焦 `manyoyo serve` 网页模式的认证行为与最小安全基线。

当前网页交互支持三种模式：`命令模式`、`AGENT 模式`、`交互终端`。其中 `AGENT 模式` 需要会话配置 `agentPromptCommand`（模板内必须包含 `{prompt}`）。

## 监听地址与启动方式

`serve` 仅支持 `<ip:port>` 格式，例如 `127.0.0.1:3000`、`0.0.0.0:3000`。

默认监听地址为 `127.0.0.1:3000`。

```bash
# 仅本机访问（默认）
manyoyo serve

# 指定监听地址
manyoyo serve 127.0.0.1:3000

# 局域网访问（需配合强密码与防火墙）
manyoyo serve 0.0.0.0:3000 -U admin -P 'StrongPassword'

# 后台启动
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d

# 后台启动并自动生成密码（会直接打印本次随机密码）
manyoyo serve 127.0.0.1:3000 -d

# 停止指定后台服务
manyoyo serve 127.0.0.1:3000 --stop

# 重启指定后台服务
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d --restart
```

## 认证参数优先级

网页认证参数包括 `serverUser` 与 `serverPass`，支持命令行、配置文件、环境变量。

优先级如下：

`命令行参数 > runs.<name> > 全局配置 > 环境变量 > 默认值`

对应环境变量：

- `MANYOYO_SERVER_USER`
- `MANYOYO_SERVER_PASS`

默认值：

- `serverUser`: `admin`
- `serverPass`: 未显式设置时，启动时自动生成随机密码并输出到终端

## 认证网关行为

`serve` 模式采用全局认证网关，除登录相关放行路由外，其余页面和接口默认要求登录。

当前匿名放行路由：

- `/auth/login`
- `/auth/logout`
- `/auth/frontend/login.css`
- `/auth/frontend/login.js`
- `/shadcn/auth/login`（见下方 shadcn/ui 预览版前端）

## shadcn/ui 预览版前端（实验性）

`serve` 模式同时提供一份基于 shadcn/ui 重写的实验性前端，用于逐步替换 `lib/web/frontend/` 下的现有前端，二者共存、互不影响。

- 预览地址：`http://127.0.0.1:3000/shadcn`；未登录会跳转到 `http://127.0.0.1:3000/shadcn/auth/login`，登录成功后跳回 `/shadcn`
- 登录页复用同一套 `/auth/login` 接口和 cookie，与旧版前端共享登录态，无需单独账号
- 源码在仓库根目录的 `frontend-shadcn/`，是独立的 Vite + React 项目，不影响本项目其余部分的 CommonJS/无构建约定

首次参与开发需要单独装一次它自己的依赖（体积较大，与根目录 `npm install` 分开，不会拖慢日常开发）：

```bash
cd frontend-shadcn && npm install && cd ..
```

之后按需选择：

```bash
# 只想看当前构建效果：手动构建一次，再照常启动 my serve 预览
npm run build:web-shadcn
manyoyo serve

# 改 frontend-shadcn/src 下的代码并实时看效果（HMR），两个终端：
manyoyo serve                # 终端一：真实后端（容器、会话、终端 WebSocket）
npm run dev:web-shadcn       # 终端二：Vite 开发服务器，默认把 /api、/auth 代理到 127.0.0.1:3000
```

`my serve` 监听地址不是默认的 `127.0.0.1:3000` 时，用 `MANYOYO_SERVE_URL` 环境变量覆盖 `dev:web-shadcn` 的代理目标。

发布时（`npm publish`/`npm pack`）会自动重新构建 `frontend-shadcn` 并把产物打进 `lib/web/frontend/shadcn.html`；生产环境运行 `my serve` 不需要 Node 之外的任何前端工具链。

## 登录与 API 访问示例

```bash
# 1) 登录并保存 cookie
curl --noproxy '*' -c /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"StrongPassword"}'

# 2) 带 cookie 访问接口
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  http://127.0.0.1:3000/api/sessions

# 3) 登出
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/logout
```

## 最小安全基线

- 优先使用 `127.0.0.1` 监听，仅本机访问
- 使用 `0.0.0.0` 时必须设置强密码，并通过防火墙限制来源 IP
- 不要把明文密码写入共享脚本；优先放到受保护配置文件或环境变量
- 定期更换 `serverPass`，共享环境使用独立账户与独立口令

## 常见问题

### 返回 `401 Unauthorized`

排查顺序：

1. 确认已完成 `/auth/login` 并带上 cookie
2. 确认 `-U` / `-P` 与配置项一致
3. 使用 `manyoyo config show` 检查 `serverUser`/`serverPass` 的最终来源

## 相关文档

- [命令参考](../reference/cli-options.md)
- [配置系统概览](../configuration/README.md)
- [配置文件详解](../configuration/config-files.md)
