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
  global-config.js      # ~/.manyoyo/manyoyo.json 读写与 imageVersion 同步
  runtime-resolver.js   # 运行配置四层合并（CLI > runs > 全局 > 默认）
  runtime-normalizers.js# parseEnvEntry / normalizeVolume / 路径归一
  worktrees.js          # Git worktrees 检测与挂载推导（--wt / --wtr）
  json5-text-edit.js    # JSON5 局部定位替换，供全局配置与 Web 配置编辑复用
  serve-log.js          # serve 日志脱敏、进程快照
  log-path.js           # 日志分目录规则
  codex-output.js       # Codex JSONL 输出解析
  dev-release.js        # 发布向导版本建议与提交文案清洗
  plugin/
    index.js            # 插件路由（当前支持 playwright）
    playwright.js       # PlaywrightPlugin：场景管理、MCP 集成、扩展下载
    playwright-assets/  # Docker Compose 及 Dockerfile 场景模板
  web/
    server.js           # HTTP + WebSocket 服务器（终端、agent 对话、登录鉴权）
    frontend/           # app / login / markdown-renderer / file-browser / codemirror
docker/
  manyoyo.Dockerfile    # 多阶段镜像构建
  cache/                # 构建缓存（Node.js、JDT LSP、gopls），有效期 2 天
  res/                  # 各 Agent 默认配置、Playwright 资源、supervisor 模板
scripts/                # dev-release.js（发布向导）、build-web-code-editor.js
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

npm run build:web-editor # codemirror.bundle.js 已加入 .gitignore，由 npm install 的
                         # prepare 钩子自动生成，本地调试可手动重跑此命令
npm run dev:release      # 维护者发布向导（--yes 自动确认，--version 指定版本）

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

### bin/manyoyo.js（2200+ 行单文件）

无分区注释，靠函数名定位：`Grep "^function <名>"`。主流程编排在此，
配置合并/归一化改动优先落到 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`。

**配置管理**
- 全局配置：`~/.manyoyo/manyoyo.json`（JSON5，支持注释），模板见 `manyoyo.example.json`
- 四层优先级：命令行 > `runs.<name>` > 全局配置 > 默认值
- 覆盖模式（标量）：`containerName`、`imageName`、`yolo`、`containerMode` 等
- 合并模式：`env`（Object，按 key 覆盖）；`envFile`、`volumes`、`ports`、`imageBuildArgs`（数组，追加）
- `envFile` **仅支持绝对路径**；`containerName` 支持 `{now}` 模板（→ `MMDD-HHmm`）

**YOLO 模式映射**（`lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS`，`setYolo()` 与 `lib/web/server.js` 的 `resolveYoloCommand()` 均委托到这里，单一数据源）
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

- `resolveYoloCommand()` 委托到 `lib/agent-adapters/index.js`，与 `bin/manyoyo.js` 共用同一份映射，无需分别维护
- Web 鉴权：所有路由默认认证，匿名白名单仅限 `/auth/login`、`/auth/logout`、`/auth/frontend/login.css`、`/auth/frontend/login.js`；新增接口必须走全局认证网关
- Agent 会话恢复参数：Claude/Gemini → `-r`，Codex → `resume`，OpenCode → `-c`

### lib/web/frontend/

- `.main` 三行 grid：`grid-template-rows: auto minmax(0, 1fr) auto`（header / 内容区 / composer）。增删 `.main` 直接子元素时必须同步调整行数，否则内容区高度失效
- `connectTerminal()` 前须加 `isActiveSessionHistoryOnly()` 守卫（三处：`setActiveTab`、`handleSessionItemClick`、`refreshSessions`），否则点击「仅历史」会话会触发后端新建容器

### Dockerfile

两阶段构建：Stage 1 检测并补全 `docker/cache/` 缓存；Stage 2 按 `TOOL` 参数安装工具。
- `TOOL`：`full`（默认）/ `common` / `go` / `java` / `codex` / `gemini` 等
- `APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`：镜像源加速

### 安全约束

- 名称验证：容器/镜像 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`；env key/value 校验在 `lib/runtime-normalizers.js` 的 `parseEnvEntry()`，key 须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，value 阻止 `[\r\n\0;&|` $<>]`
- 路径：`validateHostPath()` 阻止挂载 `/`、`/home`、`$HOME`，用 `fs.realpathSync()` 解析符号链接后验证
- 命令执行：`spawnSync()` + 参数数组，禁止 shell 字符串拼接
- 敏感数据：`lib/serve-log.js` 的 `sanitizeSensitiveData()` 掩码含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL 的值（前4+后4位）
- 日志：新增 `~/.manyoyo/logs/` 文件必须按子命令分目录（`serve/`、`build/`、`run/`），勿堆根目录

## 常用模式

### 添加新的 YOLO 智能体

1. 在 `lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS` 中新增条目（`bin/manyoyo.js` 与 `lib/web/server.js` 会自动生效，无需分别修改）
2. 更新 `docs/zh/reference/agents.md` 和 `docs/en/reference/agents.md`

### 添加新的配置选项

1. 在 `@typedef Config` JSDoc 中定义字段
2. 更新 `loadConfig()` / `loadRunConfig()`
3. 在 `setupCommander()` 中添加 CLI 选项
4. 处理配置合并（注意覆盖 vs 追加）
5. 更新 `manyoyo.example.json` 和 `docs/configuration/`

## 版本对齐

- `manyoyo` 和 `my` 指向同一入口 `bin/manyoyo.js`
- 镜像版本读取 `package.json` 的 `imageVersion` 字段（格式 `x.y.z-variant`），与 `version` 字段独立
- `playwrightCliVersion` 是 Playwright CLI 的单一来源，镜像内禁止改回 `@latest`
- `test/doc-example-version.test.js` 强制 `README.md`、`docs/{zh,en}/guide/quick-start.md`、`basic-usage.md`、`reference/cli-options.md` 的镜像版本与 `package.json.imageVersion` 同主版本，改 `imageVersion` 后不同步这 7 个文件会导致 `npm test` 失败

## 提交规范

- 简短中文动词短语，文档用 `docs:` 前缀，不超过 50 字。
- 未明确要求时不自动提交；需要时先给出 commit message 和命令让用户确认。
- 提交前：`npm test` 通过；涉及文档：`npm ci --include=optional && npm run docs:build` 无错误；涉及新配置：更新 `manyoyo.example.json`；涉及文档结构调整：中英文同步更新。
