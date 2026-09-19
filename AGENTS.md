# AGENTS.md

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。核心原则：最小改动、可验证、中英文文档一致。新增功能前先明确范围与安全影响，再动手改代码。

**动 `lib/web/` 或 `frontend-shadcn/` 之前，先读对应目录的 `AGENTS.md` 再看代码**——`lib/web/AGENTS.md`（Web 服务端与旧前端：流式协议、终端 WebSocket、同步 IO 与保活的既有结论）、`frontend-shadcn/AGENTS.md`（默认 Web 前端：组件地图、移动端与样式规范）。这两份写的都是读代码看不出来、踩过才知道的约束，跳过它们等于把同一个坑再踩一遍。

- 运行环境：Node.js >= 22，容器运行时支持 `podman` 或 `docker`。
- CLI 入口：`manyoyo` 与 `my` 指向同一可执行文件 `bin/manyoyo.js`。
- `serve` 网页模式采用全局认证网关；除登录路由外，所有页面与接口默认都需认证。

## 协作偏好

- 交流必须使用中文，回复简洁、直接、高信噪比，避免客套话。
- 代码改动尽量最小化：只改解决问题所必须的代码，严禁顺手重构无关代码或做无关格式化。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能演进默认直接切换：除非明确要求，否则不引入兼容层、过渡开关、旧路径提示等历史包袱。
- 未明确要求时不自动提交；需要提交时先给出 commit message 和命令让用户确认。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目结构

- `bin/manyoyo.js`：CLI 入口与主流程编排（2200+ 行单文件）。
- `lib/agent-adapters/`：`resolveYoloCommand` 单一数据源，CLI 与 Web 共用，新增 YOLO 智能体只需改这里。
- `lib/container-run.js` / `container-modes.js` / `image-build.js`：容器运行参数构造、common/dind/sock 模式解析、镜像构建与缓存。
- `lib/runtime-resolver.js` / `runtime-normalizers.js` / `worktrees.js`：配置四层合并、参数归一化（`parseEnvEntry` / `normalizeVolume`）、Git worktrees 挂载推导（`--wt` / `--wtr`）。
- `lib/global-config.js` / `init-config.js` / `json5-text-edit.js`：`~/.manyoyo/manyoyo.json` 读写与 `imageVersion` 同步、`init` 初始化、JSON5 局部定位替换。
- `lib/log-path.js` / `serve-log.js` / `serve-log-reader.js`：日志分目录规则、脱敏与进程快照、倒序分页读取。
- `lib/core/`：会话控制事件的创建/校验/投影与 `FileEventStore`（JSONL 追加日志 + 快照）；`app-error.js` 暂未接入 `sendJson`。
- `lib/doctor.js`、`capacity.js`、`codex-output.js`、`agent-resume.js`、`dev-release.js`：环境诊断、容量估算、Codex JSONL 解析、会话恢复参数推断、发布向导。
- `lib/plugin/`：插件路由与 Playwright 插件（场景管理、MCP 集成、compose/Dockerfile 模板）。
- `lib/web/`：`serve` 网页服务与前端静态资源；`server.js` 单文件 6100+ 行，靠 `Grep "^function <名>"` 定位，不要整文件读。
- `frontend-shadcn/`：默认 Web 前端（`/` 路由，`/shadcn` 为别名），独立 Vite + React + TS 项目，约 70 个源文件；组件地图见该目录 `AGENTS.md`。
- `docker/`：多阶段 `manyoyo.Dockerfile`、构建缓存 `cache/`（Node.js、JDT LSP、gopls，2 天有效）、各 Agent 默认配置与 supervisor 模板 `res/`。
- `docs/`：VitePress 文档，中文主维护 `docs/zh/`，英文 `docs/en/`，结构须一致。
- `test/`：Jest（`*.test.js`）；前端 Vitest 在 `frontend-shadcn/src/`（`*.test.ts(x)`，与源码同目录）。
- `scripts/`、`assets/`、`manyoyo.example.json`：构建与发布脚本、资源、配置模板。

## 构建、测试与开发命令

```bash
npm install              # 开发阶段安装/更新依赖（会更新 package-lock.json）
npm ci --include=optional # 提交前与 CI 的可复现安装（CI 不再执行 npm install）

npm run test:unit        # 开发阶段（快）：test/ 下 Jest 单测 + 前端 Vitest
npm test                 # 提交前：Jest 覆盖率（输出 coverage/）+ frontend-shadcn Vitest
                         # 注意：test/manyoyo.test.js 里 Container Mode ×3 和
                         # doctor --json ×1 会真的调 docker/podman 二进制，
                         # 没装容器运行时的环境上这 4 个必失败，不是你改坏的
npx jest test/manyoyo.test.js            # 单个测试文件
npx jest --testNamePattern="关键词"       # 按测试名称匹配

# 文档：必须先 ci 安装再构建，不能并行
npm run docs:dev|build|preview   # build 会检查 dead links；dev 听 127.0.0.1:5173，preview 听 4173

npm install -g . / npm link / npm run install-link   # 本地全局安装或软链 CLI
npm run build:web-editor # 打包 codemirror.bundle.js（已 .gitignore，npm install 的 prepare 钩子自动执行）
npm run build:web-shadcn # 构建默认前端单文件产物 shadcn.html，随 npm run prepack 自动执行
npm run dev:web-shadcn   # 默认前端本地开发；npm run test:web-shadcn 跑其 Vitest
npm run dev:release      # 维护者发布向导（--yes 自动确认，--version 指定版本）
npm run lint             # 根目录这条是占位 echo，不检查任何东西；前端的真检查是下面两条

# 改 frontend-shadcn/ 必跑这两条（根目录的 npm test 不含它们）
cd frontend-shadcn && npm run typecheck   # tsc --noEmit
cd frontend-shadcn && npm run lint        # eslint；有既存报错，基线与规则说明见该目录 AGENTS.md
```

Jest 已忽略 `temp/` 工作目录；`npm test` 会校验入口文档示例版本与 `package.json.imageVersion` 同主版本号。

没有容器运行时的机器上（`npm test` 里那 4 个用例必失败，甚至 `npx jest` 直接报 `jest-circus/build/runner.js ... was not found` 这类环境问题），前端改动用这组替代验证：`cd frontend-shadcn && npm run typecheck && npm run lint`，再回根目录 `npm run test:web-shadcn && npm run build:web-shadcn`；并在交付说明里写清楚哪些没验证。

## 编码风格

- Node.js >= 22，CommonJS（`require` / `module.exports`），不使用 ES Modules（`import` / `export`）。
- 四空格缩进，分号结尾；各 `lib/` 文件顶部 `'use strict'`，只暴露纯函数或类，不依赖全局状态。
- `bin/manyoyo.js` 负责传入 `ctx` 对象，模块不直接读取全局变量。
- CLI 选项声明靠近 `bin/manyoyo.js`；配置合并与归一化优先维护 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`，worktrees 逻辑维护 `lib/worktrees.js`。
- 命名清晰简短；优先小步改动，保持改动范围清晰。
- `frontend-shadcn/` 是例外，见该目录的 `AGENTS.md`。

## 核心架构

### bin/manyoyo.js

无分区注释，靠函数名定位：`Grep "^function <名>"`。主流程编排在此，配置合并/归一化改动优先落到 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`。

**YOLO 模式映射**（`lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS`，`setYolo()` 与 `lib/web/server.js` 的 `resolveYoloCommand()` 均委托到这里，单一数据源）

- `c`/`cc`/`claude` → `IS_SANDBOX=1 claude --dangerously-skip-permissions`
- `gm`/`g`/`gemini` → `gemini --yolo`
- `cx`/`codex` → `codex --dangerously-bypass-approvals-and-sandbox`
- `oc`/`opencode` → `OPENCODE_PERMISSION='{"*":"allow"}' opencode`

**容器模式**（`setContMode()`）：`common`（默认）标准容器；`dind` 加 `--privileged`、需手动启 `dockerd`；`sock` 加 `--privileged + -v /var/run/docker.sock`，可访问宿主机 Docker（有安全风险）。

**容器生命周期**：入口点为 `tail -f /dev/null`，默认命令存储在容器标签 `manyoyo.default_cmd`；容器就绪等待采用指数退避 100ms→2000ms，最多 30 次。

### docker/manyoyo.Dockerfile

两阶段构建：Stage 1 检测并补全 `docker/cache/` 缓存；Stage 2 按 `TOOL` 参数安装工具。

- `TOOL`：`full`（默认）/ `common` / `go` / `java` / `codex` / `gemini` 等
- `APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`：镜像源加速

## 配置与路径

- 全局配置 `~/.manyoyo/manyoyo.json`（JSON5，支持注释），模板见 `manyoyo.example.json`；用户数据默认在 `~/.manyoyo/`。
- 四层优先级：命令行 > `runs.<name>` > 全局配置 > 默认值。标量覆盖（`containerName`、`imageName`、`yolo`、`containerMode` 等）；`env` 是 map、按 key 覆盖；`envFile`、`volumes`、`ports`、`imageBuildArgs` 是数组，按「全局 → runs.<name> → 命令行」追加。`first.env` / `first.envFile` 沿用同样规则。
- `envFile` 与 `--ef/--env-file` **仅支持绝对路径**；`containerName` 支持 `{now}` 模板（→ `MMDD-HHmm`）。
- 初始化配置：`manyoyo init [agents]` 会写入 `runs.<agent>`（含 `env` map）；目标已存在时逐个询问，`--yes` 自动覆盖。
- 网页认证配置：`serverUser`、`serverPass`（环境变量 `MANYOYO_SERVER_USER`、`MANYOYO_SERVER_PASS`），优先级为 命令行 > 运行配置 > 全局配置 > 环境变量 > 默认值。
- 网页服务监听：`serve [listen]` 仅支持 `<ip:port>`（IPv6 写作 `[ip]:port`），默认 `127.0.0.1:3000`。
- 镜像版本格式：`imageVersion` 与 `run/build --iv/--image-ver` 必须为 `x.y.z-后缀`（如 `1.8.1-common`）。
- `--yes` 仅用于 `build` 与 `init` 子命令；CLI 仅支持子命令入口，传入未定义参数会报 `unknown option`。

## 测试与 TDD

默认适用于新增功能、行为变更、bug 修复；纯文档改动可例外。

- **Red**：先写失败测试，选最小 case。按领域分工：CLI → `test/manyoyo.test.js`；Web → `test/web-server-auth.test.js`；插件 → `test/plugin-command.test.js`（至少覆盖 host/container 两类场景的配置生成、参数透传、挂载或启动路径）；前端 → `frontend-shadcn/src/` 对应 Vitest 用例。
- **Green**：只做最小代码改动让测试通过，避免顺手重构。
- **Refactor**：在测试持续通过的前提下整理命名或重复逻辑，确保行为不变。
- 新增功能优先补关键分支与异常路径；涉及网页认证时至少验证未登录 `401`、登录成功可访问、登出后失效。
- 每个 bug fix 至少补一个回归用例（先失败后通过）；若无法先写失败测试，需在变更说明中写明原因与替代验证步骤。
- 开发阶段优先运行 `npm run test:unit`；提交前运行 `npm test`。

## 常用模式

**添加新的 YOLO 智能体**：在 `lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS` 新增条目（`bin/manyoyo.js` 与 `lib/web/server.js` 自动生效），再更新 `docs/{zh,en}/reference/agents.md`。

**添加新的配置选项**：`@typedef Config` JSDoc 定义字段 → 更新 `loadConfig()` / `loadRunConfig()` → `setupCommander()` 加 CLI 选项 → 处理配置合并（注意覆盖 vs 追加）→ 更新 `manyoyo.example.json` 与 `docs/configuration/`。

**常见开发任务**

- 配置合并验证：`manyoyo config show [-r <name>]`；命令预览：`manyoyo config command -r <name>`。
- 迁移已有 Agent 配置：`manyoyo init all`，然后 `manyoyo run -r claude`（或 `codex/gemini/opencode`）。
- 动态容器名验证：运行配置写 `containerName: "my-<agent>-{now}"`，用 `manyoyo config show -r <name>` 看解析结果。
- 环境文件解析：`manyoyo config show --ef /abs/path/myenv.env`；容器调试：`manyoyo run -n <name> -x /bin/bash`。
- 环境诊断：`manyoyo doctor`（人类可读）/ `manyoyo doctor --json`（脚本消费），可加 `--port <port>`。
- 镜像构建：`manyoyo build --iv <x.y.z-后缀>`（如 `1.8.4-common`），可加 `--iba TOOL=common`。
- 维护者发布：`npm run dev:release`（`-- --yes` 自动确认，`-- --version <x.y.z>` 指定版本）。
- 局域网监听：`manyoyo serve 0.0.0.0:3000 -U <user> -P <pass>`；未显式设 `-P/--pass`（或 `serverPass` / `MANYOYO_SERVER_PASS`）时启动会生成随机密码并打印到终端。
- 调接口先登录拿 cookie：`curl --noproxy '*' -c /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/auth/login -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<pass>"}'`，之后带 `-b /tmp/manyoyo.cookie` 访问。
- 常用接口：`GET /api/sessions`（列表）、`GET /api/sessions/<name>/audit`（导出会话审计）、`POST /api/sessions/<name>/remove-with-history`（删除对话历史但保留容器）。

## 安全约束

- 名称验证：容器/镜像 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`；env key/value 校验在 `lib/runtime-normalizers.js` 的 `parseEnvEntry()`，key 须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，value 阻止 `[\r\n\0;&|` $<>]`。
- 路径：`validateHostPath()` 阻止挂载 `/`、`/home`、`$HOME`，用 `fs.realpathSync()` 解析符号链接后验证。
- 命令执行：`spawnSync()` + 参数数组，禁止 shell 字符串拼接；新增输出涉及敏感信息时需脱敏。
- 敏感数据：`lib/serve-log.js` 的 `sanitizeSensitiveData()` 掩码含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL 的值（前 4 + 后 4 位）。
- 日志：新增 `~/.manyoyo/logs/` 文件必须按子命令分目录（`serve/`、`build/`、`run/`），勿堆根目录。
- 日志量：`lib/log-path.js` 只按天分文件，**没有轮转、没有保留期、没有大小上限**。不要按「每个 HTTP 请求 / 每个子进程调用 / 每个流式事件」逐条写盘（曾经这么干过，实测约 55000 条、20MB/天），高频路径上只记 warn/error。
- 在线查看日志的接口一律**不要全量 `readFileSync` + `split('\n')`**：同步读会阻塞事件循环，文件越长越糟；日期/路径类查询参数必须白名单校验（`^\d{4}-\d{2}-\d{2}$` 之类），否则会被拼出目录穿越。
- 日志内容渲染到 HTML 必须逐字段转义后再进 DOM。日志里含用户 prompt 等任意文本，用字符串拼 `innerHTML` 等于把 prompt 当代码执行。
- Web 鉴权：所有路由默认认证，匿名白名单仅限 `/auth/login`、`/auth/logout`、`/auth/frontend/login.css`、`/auth/frontend/login.js`、`/shadcn/auth/login`；新增接口/页面必须走全局认证网关，禁止在业务路由里零散补认证。
- `serve` 默认使用 shadcn 前端（`/`），`/shadcn` 仅作兼容别名；旧版前端保留在 `/legacy`。
- 使用 `serve 0.0.0.0:<port>` 对外监听时必须设置强密码，并通过防火墙限制访问来源。
- 新增容器模式或挂载选项时不放宽安全校验；`sock` 模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 调整容器内 Playwright CLI 浏览器安装链路时，必须保证 `playwright-cli install-browser` 安装到全局 `@playwright/cli` 自带的 Playwright，而不是仓库本地 `node_modules/playwright`。

## 版本对齐

- 镜像版本读取 `package.json` 的 `imageVersion`（格式 `x.y.z-variant`），与 `version` 字段独立。
- `test/doc-example-version.test.js` 强制 `README.md`、`docs/{zh,en}/guide/quick-start.md`、`basic-usage.md`、`reference/cli-options.md` 的镜像版本与 `package.json.imageVersion` 同主版本，改 `imageVersion` 后不同步这 7 个文件会导致 `npm test` 失败。
- `README.md` 的快速开始与主流程示例须与 `version` / `imageVersion` 对齐；`docs/zh/`、`docs/en/` 的历史/场景示例可用其他版本，但必须保持 `x.y.z-后缀` 格式并标注用途。
- `package.json.playwrightCliVersion` 是 Playwright CLI 版本的单一来源；镜像内安装 `@playwright/cli` 时禁止改回 `@latest`，也不要误用 `dependencies.playwright` 作为版本来源。
- 包含文件 `README.md`、`LICENSE`、`docker/manyoyo.Dockerfile`、`manyoyo.example.json` 需与发布一致；`bin/manyoyo.js` 变更时同步检查 `package.json` 的 `bin` 字段。

## 文档规范

- 中文主维护 `docs/zh/`，英文 `docs/en/`，结构须一致；文档改动需中英文同步更新，并保留兼容跳转页。
- 侧边栏在 `/zh/` 与 `/en/` 统一展示全章节导航；首页卡片需可点击跳转。
- 目录首页一律使用 `README.md`，不再新增 `index.md`；内部链接优先用仓库相对 `.md` / `README.md` 路径，保证 GitHub 网页浏览可直接跳转，站点路由由 VitePress 兼容。
- 文档修改后运行 `npm run docs:build`，检查 dead links 与 sidebar/nav 行为。
- 新增配置项或 CLI 选项时，同步更新 `manyoyo.example.json`、`docs/zh/` 与 `docs/en/`；必要时同步 `README.md` 示例。

## 提交与 PR 指引

- 简短中文动词短语，文档用 `docs:` 前缀，不超过 50 字；确需补充背景时最多追加一句精简摘要，不写分点列表、不写验证过程。
- `npm run dev:release` 的发布提交使用 `commit-diff` 产出：标题不加范围前缀，正文可使用要点列表；此例外不适用于日常提交。
- 提交信息里不写 `Co-Authored-By`、生成工具署名等任何尾注。
- 未明确要求时不自动提交；需要时先给出 commit message 和命令让用户确认。
- PR 需包含：变更摘要、测试结果（如 `npm test`）、相关文档更新说明。
- 提交前：`npm test` 通过；涉及文档：`npm ci --include=optional && npm run docs:build` 无错误；涉及新配置：更新 `manyoyo.example.json`；涉及文档结构调整：中英文同步更新。
