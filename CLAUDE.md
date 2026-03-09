# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。

## 协作偏好

- 交流必须使用中文，回复简洁实用。
- 代码改动尽量最小化，避免无关重构。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能迭代时不保留旧功能兼容逻辑（除非明确要求）。
- 未明确要求时不自动提交；需要提交时先给出 commit message 和命令让用户确认。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目结构

```
bin/manyoyo.js          # CLI 入口：配置加载、容器生命周期、Commander.js 路由
lib/
  container-run.js      # buildContainerRunArgs / buildContainerRunCommand
  image-build.js        # prepareBuildCache / buildImage（含缓存管理）
  agent-resume.js       # 各 agent 会话恢复参数与 prompt 命令模板
  init-config.js        # AI agent 初始化配置
  plugin/
    index.js            # 插件路由（当前支持 playwright）
    playwright.js       # PlaywrightPlugin：场景管理、MCP 集成、扩展下载
    playwright-assets/  # Docker Compose 及 Dockerfile 场景模板
  web/
    server.js           # HTTP + WebSocket 服务器（终端、agent 对话、登录鉴权）
    frontend/           # 前端静态文件（app.html/js/css、login、markdown 渲染）
docker/
  manyoyo.Dockerfile    # 多阶段镜像构建
  cache/                # 构建缓存（Node.js、JDT LSP、gopls），有效期 2 天
docs/zh/                # 中文文档（主维护），docs/en/ 为翻译，结构需保持一致
test/                   # *.test.js，Jest 框架
manyoyo.example.json     # 配置文件模板
```

## 开发命令

```bash
npm run test:unit        # 开发阶段（快）
npm test                 # 提交前（含覆盖率）

# 文档：必须先 ci 安装再构建，不能并行
npm ci --include=optional
npm run docs:build       # 检查 dead links

npm install -g .         # 本地安装调试

# 运行单个测试文件
npx jest test/manyoyo.test.js
# 按测试名称匹配运行
npx jest --testNamePattern="关键词"
```

## TDD 模式

默认适用于新增功能、行为变更、bug 修复；纯文档改动可例外。

- **Red**：先写失败测试，按变更领域选最小 case（CLI 优先 `test/manyoyo.test.js`；Web 优先 `test/web-server-auth.test.js`；插件优先 `test/plugin-command.test.js`）。
- **Green**：只做最小代码改动让测试通过，避免顺手重构。
- **Refactor**：在测试持续通过的前提下整理命名或重复逻辑，确保行为不变。
- 每个 bug fix 至少补一个回归用例（先失败后通过）；若无法先写失败测试，需说明原因与替代验证步骤。
- 开发阶段优先运行 `npm run test:unit`；提交前运行 `npm test`。

## 编码风格

- Node.js >= 22，CommonJS（`require` / `module.exports`），不用 ES 模块
- 四空格缩进，分号结尾
- 各 `lib/` 文件顶部 `'use strict'`，只暴露纯函数或类，不依赖全局状态
- `bin/manyoyo.js` 负责传入 `ctx` 对象，模块不直接读取全局变量

## 核心架构

### bin/manyoyo.js 分区

文件内用 `// SECTION:` 标记分区，定位代码时用 `Grep` 搜索该标记。

**配置管理**（SECTION: Configuration Management）
- 三层优先级：命令行 > `runs.<name>` > 全局配置
- 覆盖模式（标量）：`containerName`、`imageName`、`yolo`、`containerMode` 等
- 合并模式：`env`（Object，按 key 覆盖）；`envFile`、`volumes`、`ports`、`imageBuildArgs`（数组，追加）
- `envFile` **仅支持绝对路径**；`containerName` 支持 `{now}` 模板（→ `MMDD-HHmm`）

**YOLO 模式映射**（`setYolo()`）
- `c`/`cc`/`claude` → `IS_SANDBOX=1 claude --dangerously-skip-permissions`
- `gm`/`g`/`gemini` → `gemini --yolo`
- `cx`/`codex` → `codex --dangerously-bypass-approvals-and-sandbox`
- `oc`/`opencode` → `OPENCODE_PERMISSION='{"*":"allow"}' opencode`

**容器模式**（`setContMode()`）
- `common`（默认）：标准容器
- `dind`：`--privileged`，需手动启 `dockerd`
- `sock`：`--privileged + -v /var/run/docker.sock`，可访问宿主机 Docker（有安全风险）

**容器生命周期**
- 入口点为 `tail -f /dev/null`，默认命令存储在容器标签 `manyoyo.default_cmd`
- 容器就绪等待：指数退避 100ms→2000ms，最多 30 次

### lib/web/server.js

- `YOLO_COMMAND_MAP` 与 `bin/manyoyo.js` 的 `setYolo()` 保持一致，**修改时需同步两处**
- Web 鉴权：所有路由默认认证，匿名白名单仅限 `/auth/login`、`/auth/logout`、`/auth/frontend/login.css`、`/auth/frontend/login.js`；新增接口必须走全局认证网关
- Agent 会话恢复参数：Claude/Gemini → `-r`，Codex → `resume`，OpenCode → `-c`

### lib/web/frontend/

- `.main` 三行 grid：`grid-template-rows: auto minmax(0, 1fr) auto`（header / 内容区 / composer）。增删 `.main` 直接子元素时必须同步调整行数，否则内容区高度失效
- `connectTerminal()` 前须加 `isActiveSessionHistoryOnly()` 守卫（三处：`handleSessionItemClick`、`refreshSessions`、`modeTerminalBtn` 点击），否则点击「仅历史」会话会触发后端新建容器

### Dockerfile

两阶段构建：Stage 1 检测并补全 `docker/cache/` 缓存；Stage 2 按 `TOOL` 参数安装工具。
- `TOOL`：`full`（默认）/ `common` / `go` / `java` / `codex` / `gemini` 等
- `APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`：镜像源加速

### 安全约束

- 名称验证：容器/镜像 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`；env key `^[A-Za-z_][A-Za-z0-9_]*$`；env value 阻止 `[\r\n\0;&|` $<>]`
- 路径：`validateHostPath()` 阻止挂载 `/`、`/home`、`$HOME`，用 `fs.realpathSync()` 解析符号链接后验证
- 命令执行：`spawnSync()` + 参数数组，禁止 shell 字符串拼接
- 敏感数据：`sanitizeSensitiveData()` 掩码含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL 的值（前4+后4位）

## 常用模式

### 添加新的 YOLO 智能体

1. 更新 `bin/manyoyo.js` 的 `setYolo()`
2. 同步更新 `lib/web/server.js` 的 `YOLO_COMMAND_MAP`
3. 更新 `docs/zh/reference/agents.md` 和 `docs/en/reference/agents.md`

### 添加新的配置选项

1. 在 `@typedef Config` JSDoc 中定义字段
2. 更新 `loadConfig()` / `loadRunConfig()`
3. 在 `setupCommander()` 中添加 CLI 选项
4. 处理配置合并（注意覆盖 vs 追加）
5. 更新 `manyoyo.example.json` 和 `docs/configuration/`

## 版本对齐

- `manyoyo` 和 `my` 指向同一入口 `bin/manyoyo.js`
- 镜像版本读取 `package.json` 的 `imageVersion` 字段（格式 `x.y.z-variant`），与 `version` 字段独立
- 发布前：`package.json` 版本、文档示例版本、`README.md` 版本三处保持一致

## 提交规范

- 简短中文动词短语，文档用 `docs:` 前缀，不超过 50 字。
- 未明确要求时不自动提交；需要时先给出 commit message 和命令让用户确认。
- 提交前：`npm test` 通过；涉及文档：`npm ci --include=optional && npm run docs:build` 无错误；涉及新配置：更新 `manyoyo.example.json`；涉及文档结构调整：中英文同步更新。
