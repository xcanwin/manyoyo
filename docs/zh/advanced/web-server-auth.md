---
title: 网页服务认证与安全实践 | MANYOYO
description: 介绍 MANYOYO serve 模式的认证网关、参数优先级、登录流程与对外监听安全建议。
---

# 网页服务认证与安全实践

本页聚焦 `manyoyo serve` 网页模式的认证行为与最小安全基线。

## 监听地址与启动方式

`serve` 支持两种格式：

- `<port>`，例如 `3000`
- `<host:port>`，例如 `127.0.0.1:3000`、`0.0.0.0:3000`

默认监听地址为 `127.0.0.1:3000`。

```bash
# 仅本机访问（默认）
manyoyo serve

# 指定端口
manyoyo serve 3000

# 局域网访问（需配合强密码与防火墙）
manyoyo serve 0.0.0.0:3000 -u admin -P 'StrongPassword'
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
2. 确认 `-u` / `-P` 与配置项一致
3. 使用 `manyoyo config show` 检查 `serverUser`/`serverPass` 的最终来源

## 相关文档

- [命令参考](../reference/cli-options.md)
- [配置系统概览](../configuration/README.md)
- [配置文件详解](../configuration/config-files.md)
