---
title: 参与开发 | MANYOYO
description: 面向贡献者：从源码运行 MANYOYO、运行测试、构建前端与文档、发布流程概要。
---

# 参与开发

面向想改 MANYOYO 本身的人。面向 AI 编码助手的协作约定在仓库根目录的 [`AGENTS.md`](https://github.com/xcanwin/manyoyo/blob/main/AGENTS.md)，这里是给人看的概要。

## 从源码运行

要求 Node.js >= 22，以及 Docker 或 Podman。

```bash
git clone https://github.com/xcanwin/manyoyo.git && cd manyoyo
npm install
node bin/manyoyo.js --help      # 直接运行
npm link                        # 或链接成全局命令 manyoyo / my
```

## 测试

```bash
npm run test:unit               # 开发阶段：Jest 单测 + 前端 Vitest（快）
npm test                        # 提交前：带覆盖率的 Jest + 前端 Vitest
npm run test:integration        # 需要真实容器运行时的集成测试
```

## 网页前端

网页界面源码在仓库根目录的 `frontend/`（Vite + React + TypeScript + shadcn/ui），构建产物是单文件 `lib/web/index.html`。

```bash
cd frontend && npm ci && cd ..   # 首次需要单独装一次依赖
npm run build:web                # 构建
npm run dev:web                  # 热更新开发（另开终端运行 manyoyo serve 作为后端）
```

细节与规范见 `frontend/AGENTS.md`；服务端约束见 `lib/web/AGENTS.md`。

## 文档站

文档使用 **VitePress**，推送 `main` 后由 GitHub Actions 部署到 GitHub Pages。中文是主维护语言，英文同批同步，结构保持一致。

```bash
npm ci --include=optional        # 必须先安装依赖，再构建，不能并行
npm run docs:dev                 # 本地开发，默认只监听 127.0.0.1:5173
npm run docs:build               # 构建并检查死链
```

## 发布概要

发布由维护者执行：`npm run dev:release` 的向导负责版本号与发布提交；安装包、镜像和 Release 只在 CI 中构建并经隐私扫描。完整顺序见 [`AGENTS.md`](https://github.com/xcanwin/manyoyo/blob/main/AGENTS.md) 的「发版顺序」。

## 下一步

- [自定义镜像](./custom-image.md)
- [会话管理与恢复](./session-management.md)
