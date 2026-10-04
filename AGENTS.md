# AGENTS.md

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。核心原则：最小改动、可验证、中英文文档一致。新增功能前先明确范围与安全影响，再动手改代码。

**动 `lib/web/` 或 `frontend/` 之前，先读对应目录的 `AGENTS.md` 再看代码**——`lib/web/AGENTS.md`（Web 服务端：流式协议、终端 WebSocket、同步 IO 与保活的既有结论）、`frontend/AGENTS.md`（默认 Web 前端：组件地图、移动端与样式规范）。这两份写的都是读代码看不出来、踩过才知道的约束，跳过它们等于把同一个坑再踩一遍。

- 运行环境：Node.js >= 22，容器运行时支持 `podman` 或 `docker`。macOS 离线包（及 Linux 离线包）自带 Node.js，完整 macOS 包还自带私有 Podman。
- 默认镜像是 `ghcr.io/xcanwin/manyoyo`（本地没有时自动拉取）；向导与快捷对话的默认工作目录是 `~/.manyoyo/work/`（7.x 遗留的 `workpath/` 仅在卸载时询问）。
- CLI 入口：`manyoyo` 与 `my` 指向同一可执行文件 `bin/manyoyo.js`。
- `serve` 网页模式采用全局认证网关；除登录路由外，所有页面与接口默认都需认证。

## 协作偏好

- 交流必须使用中文，回复简洁、直接、高信噪比，避免客套话。
- 代码改动尽量最小化：只改解决问题所必须的代码，严禁顺手重构无关代码或做无关格式化。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能演进默认直接切换：除非明确要求，否则不引入兼容层、过渡开关、旧路径提示等历史包袱。
- 未明确要求时不自动提交；需要提交时先给出 commit message 和命令让用户确认。
- 推送与其他对外动作（合并 main、触发 workflow、发布）一律先要明确授权，有凭据也不例外。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目结构

- `bin/manyoyo.js`：CLI 入口与主流程编排（2200+ 行单文件）。
- `lib/agent-adapters/`：`resolveYoloCommand` 单一数据源，CLI 与 Web 共用，新增 YOLO 智能体只需改这里。
- `lib/uninstall.js` / `proxy-config.js` / `offline-import.js`：`manyoyo uninstall`（精确移除带标记的 PATH 块、停服务与私有 machine、用户数据逐项询问）、安装时把用户的代理设置抄进私有 Podman 的 `containers.conf`、离线包后台导入镜像时的状态标记（serve/CLI 据此等待而不是去仓库拉）。用户入口是 `scripts/install.sh`（`curl … | sh` 的下载引导脚本：判断系统与芯片 → 跟随 `releases/latest` 跳转取版本（不调 GitHub API）→ 下载并按 `SHA256SUMS` 校验 `.run` → 有 tty 时 `</dev/tty`、无 tty 时加 `--headless` 后启动；不进 npm 包，不装任何东西，只下载、校验、启动）；装完后 `.run` 调用隐藏入口 `manyoyo --post-install`（`lib/post-install.js`）：有图形界面直接启动网页服务并开浏览器；无头 + 有终端问“1 在终端里配置（默认）/ 2 启动网页版 / 3 先不配置”；无头 + 没有终端只安装、不启动任何服务；并提示 PATH 里另一份 manyoyo、还在跑旧版代码的 serve（`lib/serve-instances.js`，靠 `~/.manyoyo/run/serve/*.pid`，与 `manyoyo serve --list` 共用）。`--install-only` 只安装（旧名 `--no-open` 已删，不留别名）。真正的安装逻辑在 `.run` 里的 `scripts/offline/install.sh`（POSIX sh，只用 macOS / Linux 自带命令；只有 Linux 缺 podman 或 rootless 默认网络组件（podman 4.x slirp4netns / 5.x passt）、且 `/dev/tty` 可读、用户回答 Y 时才执行一条按发行版生成的 sudo 安装命令，没有终端或回答 n 只打印命令并失败，不加任何开关；Linux 包 `MANYOYO_OS=linux`：不带 Podman，检测系统 docker/podman，同一套规则在 `lib/rootless-network.js` 里有 JS 版，供 `doctor` 与 `run` 失败提示共用，测试见 `test/installer.test.js`）。Linux 包由 `build-packages.yml` 构建（`build.js --platform linux`，内部 kind 为 lite，扫描用 `scan-allowlist-linux.json`）。
- `lib/app-update.js` / `update-check.js` / `download-verified.js`：离线包安装的增量升级（查最新 Release → 只下 `-app.tar.gz` 并校验 → `app/<版本>/` + 原子切换 `current` + 保留上一版本 + `update --rollback`，npm 安装不经过这里）、serve 每天最多一次的新版本检查（`updateCheck` 可关，请求不带本机信息，结果走 `GET /api/system/update`）、带 SHA256 校验的下载。升级包命名约定：`manyoyo-<ver>-<os>-<arch>-app.tar.gz` 与单一校验清单 `SHA256SUMS`（`os` 为 `macos` 或 `linux`，包内 manifest 的 `os` 字段会被校验；这两个名字已安装的 8.0.1 客户端按名查找，不能改），必须上传到 GitHub Release；Release 里是 4 个 `.run`、4 个 `-app.tar.gz`、1 个 `SHA256SUMS` 共 9 个资产；Intel 完整包超过 2 GiB 时 `.run` 分卷成 `.run.001/.002…`，所以资产数以 `SHA256SUMS` 为准（控制台按“清单与资产完全一致”判断，不写死个数；`release-offline.yml` 一次运行合并上传四个平台，没有精简包与 `release-manifest`）。macOS 升级包的 `manifest.json` 带 `runtime: { podmanVersion, vmDiskSha256 }`，`manyoyo update` 据此提示是否需要换完整包。
- `lib/headless.js` / `setup-cli.js` / `setup-config.js`：有头/无头判定（安装器与无参 `manyoyo` 共用，`--headless`/`--gui`/`MANYOYO_HEADLESS`）、无头环境的命令行配置向导 `manyoyo setup`（输入不回显、非 TTY 不挂起）、向导写配置的文本构造（与 `/api/setup/*` 同源，写入走 `lib/secure-file.js`）。命令行向导的步骤、用词与网页向导保持一致（第 1/4 步选 Agent → 接入方式（Base URL → Key → 模型）→ 工作目录 → 密码），提示默认项写“[默认选N]”。
- `lib/podman-passthrough.js`：`manyoyo podman <参数>` 透传私有 Podman、`manyoyo podman env` 输出只在当前终端定义 `podman` 函数的 shell 代码。
- `lib/container-runtime.js` / `runtime-heal.js` / `error-hints.js`：容器运行时选择（配置 > 私有 Podman > daemon 可用的 docker/podman，返回 `{command, env, source}`，`env` 只传给运行时子进程）、daemon 不可用时的自愈（`podman machine start` / macOS `open -a Docker`）、原始错误到“原因 + 下一步”的映射。
- `lib/mirrors.js`：全局配置 `mirrors`（apt/npm/pip 软件源）在容器层生效——npm/pip 走环境变量，apt 在创建后以固定脚本改写（地址只经 env 传入）；预设源在 `lib/setup.js` 的 `MIRROR_PRESETS`，镜像本身不变。
- `lib/container-run.js` / `container-modes.js` / `image-build.js`：容器运行参数构造（`runWithEnvFile` 创建容器时把 `--env KEY=值` 挪进 `~/.manyoyo/tmp` 下 0600 的临时 env 文件，密钥不进 ps 与错误信息；报错与 show-command 里的敏感 env 经 `redactCommandArgs` 打码）、common/dind/sock 模式解析、镜像构建与缓存。
- `lib/runtime-resolver.js` / `runtime-normalizers.js` / `worktrees.js`：配置四层合并、参数归一化（`parseEnvEntry` / `normalizeVolume`）、Git worktrees 挂载推导（`--wt` / `--wtr`）。
- `lib/secure-file.js`：含凭据的配置写入（文件 0600、`.manyoyo` 目录 0700、临时文件 + rename 原子替换），`manyoyo.json` 的所有写入点都走它。
- `lib/global-config.js` / `init-config.js` / `json5-text-edit.js`：`~/.manyoyo/manyoyo.json` 读写与 `imageVersion` 同步、`init` 初始化、JSON5 局部定位替换。
- `lib/log-path.js` / `serve-log.js` / `serve-log-reader.js`：日志分目录规则、脱敏与进程快照、倒序分页读取。
- `lib/core/`：会话控制事件的创建/校验/投影与 `FileEventStore`（JSONL 追加日志 + 快照）；`app-error.js` 暂未接入 `sendJson`。
- `lib/doctor.js`、`capacity.js`、`codex-output.js`、`agent-resume.js`：环境诊断、容量估算、Codex JSONL 解析、会话恢复参数推断。
- `scripts/release/`：发布控制台（维护者工具，不进 npm 包），**唯一的发布入口**：网页（人用，`npm run release`，`127.0.0.1:3900`，令牌 + Host/Origin 校验，只能选固定阶段、不能提交任意命令）与命令行（agent 用，`--status [--json]` / `--notes-draft` / `--run <阶段,…> [--yes]` / `--check <id>`，`--help` 有完整用法与典型流程）共用同一套引擎。状态完全由 git / GitHub / npm 的真实状态推出（`facts.js` → `stages.js`），可随时中断续跑；阶段执行在 `actions.js`，任务执行器 `jobs.js`（single / 逐步确认 step / 一次确认 auto；相邻同组阶段 verify ∥ npm 并行），`lock.js` 是网页与命令行共用的跨进程单实例锁（持有者 pid 已死则接管）。对外动作每次都要确认（网页弹窗；命令行必须加 `--yes`，否则只打印命令并以退出码 2 结束）。`device-rules.js` 是发布前真机检查的区域规则（数据，按“自上个 tag 以来改了哪些文件”匹配，只匹配会在用户机器上运行的文件，CI-only 构建脚本和控制台自己的页面不算），勾选只能由人做（网页，或有 TTY 的 `--check`；没有 TTY 拒绝）。页面源码在 `frontend/release.html` + `frontend/src/release/`，`npm run build:release` 构建成 `scripts/release/console.html`（已忽略，首次运行自动构建）。`--dry-run` 对外动作只打印命令（本地检查如 preflight 仍会真跑）。
- `lib/plugin/`：Playwright 插件，容器内浏览器只有四种模式（默认容器内 Xvfb 有头 / `headed` / `chrome` / `vnc`），同一时间一个。宿主机 `~/.manyoyo/plugin/playwright/current/` 以**目录**只读挂进容器 `/run/manyoyo-playwright/`，`config.json` 一律原子替换，切模式后已运行容器自动跟随（不要改回单文件挂载）；`fingerprint.js` 是指纹唯一数据源，`docker/res/playwright/{browser.json,stealth.init.js}` 由 `scripts/gen-playwright-res.js` 生成并有单测校验；`playwright-relay.js`（chrome 中继，只放行带 token 的 upgrade）、`playwright-server.js`（宿主机/vnc 容器里的浏览器服务）、`playwright-probe.js`（真实探测）、`playwright-assets/`（vnc 镜像）；`buildContainerIntegration` 是 CLI run 与 Web 建会话共用的唯一入口，永远不能因 playwright 让 run 退出。Playwright 1.64 起浏览器服务只绑 loopback 时会校验 Host（非 localhost/127.0.0.1 一律 403），所以 headed 在所有平台监听 0.0.0.0 + token；rootless 运行时的发布端口在容器没起来时 TCP 也能连上，就绪/存活判断不能只看端口。
- `lib/web/`：`serve` 网页服务；`server.js` 单文件 6000+ 行，靠 `Grep "^function <名>"` 定位，不要整文件读。
- `frontend/`：默认 Web 前端（`/` 路由，登录页 `/auth/login`；React + shadcn/ui），独立 Vite + React + TS 项目，约 70 个源文件；组件地图见该目录 `AGENTS.md`。
- `docker/`：多阶段 `manyoyo.Dockerfile`、构建缓存 `cache/`（Node.js、JDT LSP、gopls，2 天有效）、各 Agent 默认配置与 supervisor 模板 `res/`。
- `docs/`：VitePress 文档，中文主维护 `docs/`（`/en/` 以外都是中文，站点根路径就是中文首页），英文 `docs/en/`，结构须一致；旧地址（`/zh/**` 与移动过的页面）由构建期 `buildEnd` 按 `docs/.vitepress/redirects.mts` 与 `redirects.json` 生成静态 meta refresh 页，仓库里不放跳转页；`node scripts/check-docs-seo.js` 检查构建产物。
- `test/`：Jest（`*.test.js`），依赖真实容器运行时的用例在 `test/integration/`；前端 Vitest 在 `frontend/src/`（`*.test.ts(x)`，与源码同目录）。
- `scripts/`、`assets/`、`manyoyo.example.json`：构建与发布脚本、资源、配置模板。`scripts/offline/`（离线包构建：下载校验、无 pkgutil 的 `.pkg` 解包、krunkit 补丁、`.run` 打包；完整包默认不分卷，分卷只在超过 GitHub 单文件 2 GiB 时兜底）与 `scripts/scan-release-artifacts.js`（发布产物隐私扫描）只在 CI 运行，发布产物不要在本机构建；`dist-offline/` 已被 `.gitignore` 忽略。

## 构建、测试与开发命令

```bash
npm install              # 开发阶段安装/更新依赖（会更新 package-lock.json）
npm ci --include=optional # 提交前与 CI 的可复现安装（CI 不再执行 npm install）

npm run test:unit        # 开发阶段（快）：test/ 下 Jest 单测（不含 test/integration/）+ 前端 Vitest
npm test                 # 提交前：Jest 覆盖率（输出 coverage/）+ frontend Vitest
                         # 需要真实 docker/podman 的用例都在 test/integration/，
                         # docker info / podman info 失败时自动跳过并打印原因
npm run test:integration # 只跑 test/integration/（容器运行时集成测试）
npm run test:installer   # 只跑安装脚本用例（改 scripts/install.sh / scripts/offline/*.sh 时）
npm run lint:sh          # shellcheck 检查安装脚本；本机没有 shellcheck 会明确报错（不会静默跳过）
npx jest test/manyoyo.test.js            # 单个测试文件
npx jest --testNamePattern="关键词"       # 按测试名称匹配

# 文档：必须先 ci 安装再构建，不能并行
npm run docs:dev|build|preview   # build 会检查 dead links；dev 听 127.0.0.1:5173，preview 听 4173
npm run docs:check               # docs:build + scripts/check-docs-seo.js（跳转页、canonical、description、sitemap）

npm start                # 从源码运行无参入口（打开网页界面）；npm run serve:dev 前台调试 serve（127.0.0.1:3000）
npm install -g . / npm link   # 本地全局安装或软链 CLI
npm run build:web        # 构建默认前端单文件产物 lib/web/index.html，随 npm run prepack 自动执行
npm run dev:web          # 默认前端本地开发；npm run test:web 跑其 Vitest
npm run release          # 维护者发布控制台（网页，127.0.0.1:3900）；--status 终端看状态，--dry-run 彩排；npm run build:release 单独构建页面
# 根目录除 lint:sh（只管安装脚本）外没有 lint 脚本；前端的真检查是下面两条

# 改 frontend/ 必跑这两条（根目录的 npm test 不含它们）
cd frontend && npm run typecheck   # tsc -b --noEmit（必须 -b，否则一个文件都不检查）
cd frontend && npm run lint        # eslint；有既存报错，基线与规则说明见该目录 AGENTS.md
```

Jest 已忽略 `temp/` 工作目录；`npm test` 会校验入口文档示例版本与 `package.json.imageVersion` 同主版本号。

`npx jest` 若直接报 `jest-circus/build/runner.js ... was not found`，是 node_modules 损坏，先 `npm ci --include=optional` 重装；重装仍无法跑 Jest 时，前端改动用这组替代验证：`cd frontend && npm run typecheck && npm run lint`，再回根目录 `npm run test:web && npm run build:web`；并在交付说明里写清楚哪些没验证。没有容器运行时不影响 `npm test`（集成测试自动跳过）。

## 编码风格

- Node.js >= 22，CommonJS（`require` / `module.exports`），不使用 ES Modules（`import` / `export`）。
- 四空格缩进，分号结尾；各 `lib/` 文件顶部 `'use strict'`，只暴露纯函数或类，不依赖全局状态。
- `bin/manyoyo.js` 负责传入 `ctx` 对象，模块不直接读取全局变量。
- CLI 选项声明靠近 `bin/manyoyo.js`；配置合并与归一化优先维护 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`，worktrees 逻辑维护 `lib/worktrees.js`。
- 命名清晰简短；优先小步改动，保持改动范围清晰。
- `frontend/` 是例外，见该目录的 `AGENTS.md`。

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
- `--yes` 仅用于 `build`、`init` 与 `uninstall` 子命令（`uninstall --yes` 只确认程序本身的卸载，绝不删除配置、历史、日志、工作目录和外部运行时里的容器与镜像）；CLI 仅支持子命令入口，传入未定义参数会报 `unknown option`。

## 测试与 TDD

默认适用于新增功能、行为变更、bug 修复；纯文档改动可例外。

- **Red**：先写失败测试，选最小 case。按领域分工：CLI → `test/manyoyo.test.js`；Web → `test/web-server-auth.test.js`；插件 → `test/plugin-command.test.js`（至少覆盖 host/container 两类场景的配置生成、参数透传、挂载或启动路径）；前端 → `frontend/src/` 对应 Vitest 用例。
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
- 维护者发布：`npm run release`，按页面「下一步」推进；也可「一键发布」整段（合并 main → 验证）。
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
- Web 鉴权：所有路由默认认证，匿名白名单仅限 `/auth/login`、`/auth/logout`；新增接口/页面必须走全局认证网关，禁止在业务路由里零散补认证。未登录的页面请求一律 302 到 `/auth/login`，`/api/*` 与 `/auth/*` 返回 401。
- `serve` 的 Web 界面只有 `frontend/` 一套（`/`，登录页 `/auth/login`），服务端不再托管任何散装前端静态资源。
- 使用 `serve 0.0.0.0:<port>` 对外监听时必须设置强密码，并通过防火墙限制访问来源。
- 新增容器模式或挂载选项时不放宽安全校验；`sock` 模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 调整容器内 Playwright CLI 浏览器安装链路时，必须保证 `playwright-cli install-browser` 安装到全局 `@playwright/cli` 自带的 Playwright，而不是仓库本地 `node_modules/playwright`。

## 离线包与安装器的踩坑（读代码看不出来）

- 安装脚本（`scripts/offline/install.sh`、`finish-import.sh`、`.run` 头）在 macOS 上由 bash 3.2 当 sh 执行：**变量名后紧跟中文/全角字符必须写 `${VAR}`**（否则 `set -u` 下直接崩溃，Linux 的 dash 复现不了），`test/installer.test.js` 有防回归。发布前必须在真实 macOS 新用户下跑一遍，容器里的测试覆盖不到。
- 清理镜像不要用 `rmi --force`：Podman 会连带删除正在使用该镜像的容器。安装器遇到已存在的私有 machine 不 `rm` 也不 `init`；`update` / `build` / 安装 / 卸载（`--yes`）都不得删除用户的旧容器。
- 发布产物（npm 包、离线包、镜像）只在 CI 构建并经 `scripts/scan-release-artifacts.js` 扫描：解不开/解包不完整的文件按“未扫描”失败，`--exclude` 必须 `^` 锚定，允许列表按具体文件放行（镜像里曾扫出 SSH 主机私钥）。
- 含凭据的配置写入统一走 `lib/secure-file.js`（0600、临时文件 + rename）；`manyoyo.json` 的任何新写入点都不要直接 `writeFileSync`。
- 镜像内容变化（新增系统包等）后，先检查 `scan-allowlist-image.json` 是否需要放行新的误报，再看产物体积：macOS Intel 完整包超过 2 GiB 会被分卷成 `.run.001/.002`，Release 资产数随之变化。
- 改了代码就要重新触发 `build-packages.yml`（macOS 与 Linux 四个平台一次构建）并在干净用户下重测；镜像（`ghcr.io/xcanwin/manyoyo:<imageVersion>`）只有 Dockerfile 或 `docker/` 变化才需要重发，且要先于离线包；`image-publish.yml` 不会覆盖已有 tag（docker/ 变了必须先升 `imageVersion`），非 main 的 ref 强制 `dryRun`。
- 发版（维护者）一律用发布控制台，不再手敲 gh 命令序列：`npm run release -- --status` 看卡在哪 → `--run version --version x.y.z` → `--run commit --files … --message …` → `git push -u origin <分支>`（需授权）后 `ci.yml` 在同一提交上通过，或本地 `--run preflight`（约 5 分钟）→ `--run merge,packages --yes`（镜像有变化先 `image`；`--yes` 授权的是该条命令里的全部对外阶段，授权范围多大就把阶段切成几条）→ `--run device`（按改动区域匹配的**发布前**真机检查，用 CI 产物安装；命中时停在这里，由人检查后在网页勾选或 `--check <id>`）→ `--notes-draft > notes.md` 编辑 → `--run release,assets,publish,verify,npm --yes --notes-file notes.md`。Release 先建**草稿**（不创建 tag，不会成为 `releases/latest`，`--target` 钉在安装包构建的提交上）→ `release-offline.yml`（单个 `runId`）上传并核对资产与 `SHA256SUMS` 完全一致 → `publish` 才改为公开（这时才有 tag、成为 latest，并以 `release: published` 触发 `npm-publish.yml`；没触发时 `--npm-dispatch`）→ `release-verify.yml`（游客身份在 Linux x64/arm64 与 macOS arm64/Intel 的 runner 上验证安装、`update`、卸载；macOS 不启动虚拟机）。发布前测试失败只需删草稿；已公开的 Release 与 npm 版本不删，前进修复。macOS 真实虚拟机启动、浏览器向导、Agent 对话只能在真机抽查。
- 新 workflow 文件在合并到默认分支前无法 `workflow_dispatch`：要在分支上实测，临时给它加 `on: push: branches: [<分支>]` + `paths` 过滤，测完删掉；已存在于 main 的 workflow（如 `image-publish.yml`）可以 `gh workflow run … --ref <分支>`。
- 镜像内容变化后本地预扫：`npm run scan:image -- ghcr.io/xcanwin/manyoyo:<ver>`（不带 `--auto-identity`，本机用户名会在 libgcrypt 里命中 `build-identity` 误报），比等 CI 才发现允许列表缺项省一轮；`build-packages.yml` 的镜像扫描结果按“镜像 ID + 允许列表 + 扫描器”哈希缓存。

## 开发流程踩坑（踩过才知道）

- 全新检出先 `npm run build:web`（生成 `lib/web/index.html`）再 `npm test`，否则 Web 页面用例失败；CI 的 `npm-publish.yml` 已先构建。
- 用脚本/工具整文件重写 `.sh` 会丢可执行位：提交前看 `git diff --cached --summary`，不应出现 `mode change`。
- 文档：frontmatter 的 `description` 含英文冒号加空格必须加引号，正文里裸 `<name>` 会被当 Vue 标签，须放进反引号；否则 `docs:build` 报错。移动页面先登记 `redirects.json`，再跑 `npm run docs:check`。
- 测试隔离：Jest 里改 `process.env.HOME` 不影响 `os.homedir()`；会写 `~/.manyoyo` 的代码路径（含插件状态、`web-server-*.test.js`）必须显式注入临时 `homeDir`，否则会污染开发者真实目录。`manyoyo build` 会把 `imageVersion` 写回真实 `~/.manyoyo/manyoyo.json`，本地验证后记得还原。
- 测试里起本进程的 HTTP 替身时，被测子进程必须异步 `spawn`；`spawnSync` 会卡住替身，表现为无输出超时。兼容性回归用仓库内 fixture（`test/fixtures/`），不要依赖 git tag（CI 浅克隆拿不到）。
- 改 workflow 后先用 `python3 -c "import yaml; yaml.safe_load(open('<文件>'))"` 校验语法；`set -e` 下 `! cmd` 不会失败，检查“不存在”要写 `if cmd; then exit 1; fi`。
- 开发容器若 PID 1 是 `tail -f /dev/null`，孤儿进程不会被回收，僵尸耗尽 cgroup 的 pids 上限后测试随机报“无法创建线程”/`spawn EAGAIN`；这时用 `docker run --rm -v "$PWD:$PWD" -w "$PWD" node:22-bookworm bash -lc '<命令>'` 在干净容器里验证，并让维护者重启容器。不要用 `pkill -f` / `pgrep -f` 匹配带自己命令行的模式，会杀掉自己的 shell。
- 机器上同时装了 docker 和 podman（如 CI 的 ubuntu）时，集成测试和被测代码必须用同一套运行时选择（`selectContainerRuntime`，docker 优先），否则镜像导进 podman、脚本却去 docker 找。子 agent 的 worktree 若放在仓库内（`.claude/worktrees/`）要用完即合并删除；jest 已忽略 `.claude/`，但子 agent 写在 worktree 里的 `temp/` 反馈会随 worktree 一起丢，让它写主检出的绝对路径。
- 子 agent 批量精简文档后，必须抽查事实（命令、参数、默认值以代码为准），删掉其自述“未核实”的新增内容。
- 推送、合并 main、触发 workflow、发 Release/npm 等对外动作，**即使已有 git/gh 凭据，也必须先得到用户明确授权**，授权只对当次指定的动作有效。获授权后若环境没配 git 凭据，可用 `git -c credential.helper='!gh auth git-credential' push origin <分支>`。发布后几分钟内 `npm view` 可能仍是旧版本，甚至在新旧版本间来回跳（CDN 节点同步有先后）：以 npm-publish 日志里的 `+ @xcanwin/manyoyo@<版本>` 为准，连续多次读到新版本才算可见（发布控制台就是这么判断的）。

## 版本对齐

- 镜像版本读取 `package.json` 的 `imageVersion`（格式 `x.y.z-variant`），与 `version` 字段独立。
- `test/doc-example-version.test.js` 扫描 `README.md` 与 `docs/**/*.md`（排除 `docs/.vitepress/`），所有 `x.y.z-后缀` 镜像版本示例必须与 `package.json.imageVersion` 同主版本，改 `imageVersion` 后不同步会导致 `npm test` 失败；确需保留的历史示例写进该测试的 `ALLOWED_HISTORICAL_VERSIONS` 白名单（文件 + 版本 + 原因），默认为空。
- `README.md` 的快速开始与主流程示例须与 `version` / `imageVersion` 对齐；`docs/`、`docs/en/` 的历史/场景示例可用其他版本，但必须保持 `x.y.z-后缀` 格式并标注用途。
- `package.json.playwrightCliVersion` 是 Playwright CLI 版本的单一来源；镜像内安装 `@playwright/cli` 时禁止改回 `@latest`，也不要误用 `dependencies.playwright` 作为版本来源。
- 包含文件 `README.md`、`LICENSE`、`docker/manyoyo.Dockerfile`、`manyoyo.example.json` 需与发布一致；`bin/manyoyo.js` 变更时同步检查 `package.json` 的 `bin` 字段。

## 文档规范

- 中文主维护 `docs/`（`/en/` 以外），英文 `docs/en/`，结构须一致；文档改动需中英文同步更新。页面移动后在 `docs/.vitepress/redirects.json` 的 `moved` 里登记旧→新路径（构建期自动生成跳转页），不要手写跳转 `.md`；不要用 JS 跳转。
- 侧边栏在中文（根路径）与 `/en/` 统一展示 6 组导航（前两组展开、其余折叠）；首页卡片需可点击跳转；每页必须有自己的 `title` / `description`。
- 目录首页一律使用 `README.md`，不再新增 `index.md`；内部链接优先用仓库相对 `.md` / `README.md` 路径，保证 GitHub 网页浏览可直接跳转，站点路由由 VitePress 兼容。
- 文档修改后运行 `npm run docs:build`，检查 dead links 与 sidebar/nav 行为。
- 新增配置项或 CLI 选项时，同步更新 `manyoyo.example.json`、`docs/` 与 `docs/en/`；必要时同步 `README.md` 示例。

## 提交与 PR 指引

- 简短中文动词短语，文档用 `docs:` 前缀，不超过 50 字；确需补充背景时最多追加一句精简摘要，不写分点列表、不写验证过程。
- 提交信息里不写 `Co-Authored-By`、生成工具署名等任何尾注。
- 未明确要求时不自动提交；需要时先给出 commit message 和命令让用户确认。
- PR 需包含：变更摘要、测试结果（如 `npm test`）、相关文档更新说明。
- 提交前：`npm test` 通过；涉及文档：`npm ci --include=optional && npm run docs:build` 无错误；涉及新配置：更新 `manyoyo.example.json`；涉及文档结构调整：中英文同步更新。
