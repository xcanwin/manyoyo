# AGENTS.md

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。核心原则：最小改动、可验证、中英文文档一致。新增功能前先明确范围与安全影响，再动手改代码。

**动 `lib/web/` 或 `frontend/` 之前，先读对应目录的 `AGENTS.md` 再看代码**——`lib/web/AGENTS.md`（Web 服务端：流式协议、终端 WebSocket、同步 IO 与保活的既有结论）、`frontend/AGENTS.md`（默认 Web 前端：组件地图、移动端与样式规范）。这两份写的都是读代码看不出来、踩过才知道的约束，跳过它们等于把同一个坑再踩一遍。

- 运行环境：Node.js >= 22，容器运行时支持 `podman` 或 `docker`。macOS 离线包（及 Linux 离线包）自带 Node.js，完整 macOS 包还自带私有 Podman。
- 默认镜像是 `ghcr.io/xcanwin/manyoyo`（本地没有时自动拉取）；向导与快捷对话的默认工作目录是 `~/.manyoyo/work/`（7.x 遗留的 `workpath/` 仅在卸载时询问）。
- CLI 入口：`manyoyo` 与 `my` 指向同一可执行文件 `bin/manyoyo.js`。
- `serve` 网页模式采用全局认证网关；除登录路由外，所有页面与接口默认都需认证。

## 协作偏好

- 交流必须使用中文，回复简洁、直接、高信噪比，避免客套话。文档与界面提示文字要言简意赅、通俗易懂（一句话说清，不堆术语，不写实现细节）。
- 代码改动尽量最小化：只改解决问题所必须的代码，严禁顺手重构无关代码或做无关格式化。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能演进默认直接切换：除非明确要求，否则不引入兼容层、过渡开关、旧路径提示等历史包袱。
- 未明确要求时不自动提交；需要提交时先给出 commit message 和命令让用户确认。
- 推送与其他对外动作（合并 main、触发 workflow、发布）一律先要明确授权，有凭据也不例外。唯一例外：用户明确要求发布时，`npm run release -- --remote` 本身就是对这一次发布的授权（推送 main、触发流水线、公开 Release、发 npm），不需要再加 `--yes` 或逐步确认。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目结构

- `bin/manyoyo.js`：CLI 入口与主流程编排（2200+ 行单文件）。
- `lib/agent-adapters/`：`resolveYoloCommand` 单一数据源，CLI 与 Web 共用，新增 YOLO 智能体只需改这里。
- `lib/uninstall.js` / `proxy-config.js` / `offline-import.js`：`manyoyo uninstall`（精确移除带标记的 PATH 块、停服务与私有 machine、用户数据逐项询问）、安装时把用户的代理设置抄进私有 Podman 的 `containers.conf`、离线包后台导入镜像时的状态标记（serve/CLI 据此等待而不是去仓库拉）。用户入口是 `scripts/install.sh`（对外地址 `curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh`，由 VitePress `buildEnd` 从该文件原样复制到站点根，`check-docs-seo.js` 断言一致，因为直连用户的 `raw.githubusercontent.com` 会被按 SNI 重置；下载引导脚本：判断系统与芯片 → 读代理（`https_proxy`，macOS 没设变量时用 `scutil --proxy` 的系统代理并导出）→ 跟随 `releases/latest` 跳转取版本（不调 GitHub API）→ 下载并按**固定取自 GitHub 官方**的 `SHA256SUMS` 校验 `.run`（`MANYOYO_DOWNLOAD_BASE` 只换 `.run` 的来源，`MANYOYO_SUMS_BASE` 仅测试钩子）；每次失败都打印完整地址与手动办法 → 有 tty 时 `</dev/tty`、无 tty 时加 `--headless` 后启动；不进 npm 包，不装任何东西，只下载、校验、启动）；装完后 `.run` 调用隐藏入口 `manyoyo --post-install`（`lib/post-install.js`）：有图形界面直接启动网页服务并开浏览器；无头 + 有终端问“1 在终端里配置（默认）/ 2 启动网页版 / 3 先不配置”；无头 + 没有终端只安装、不启动任何服务；并提示 PATH 里另一份 manyoyo、还在跑旧版代码的 serve（`lib/serve-instances.js`，靠 `~/.manyoyo/run/serve/*.pid`，与 `manyoyo serve --list` 共用）。`--install-only` 只安装（旧名 `--no-open` 已删，不留别名）。真正的安装逻辑在 `.run` 里的 `scripts/offline/install.sh`（POSIX sh，只用 macOS / Linux 自带命令；只有 Linux 缺 podman 或 rootless 默认网络组件（podman 4.x slirp4netns / 5.x passt）、且 `/dev/tty` 可读、用户回答 Y 时才执行一条按发行版生成的 sudo 安装命令，没有终端或回答 n 只打印命令并失败，不加任何开关；Linux 包 `MANYOYO_OS=linux`：不带 Podman，检测系统 docker/podman，同一套规则在 `lib/rootless-network.js` 里有 JS 版，供 `doctor` 与 `run` 失败提示共用，测试见 `test/installer.test.js`）。Linux 包由 `build-packages.yml` 构建（`build.js --platform linux`，内部 kind 为 lite，扫描用 `scan-allowlist-linux.json`）。
- `lib/code-update.js` / `scripts/offline/build-code.js` / `.github/workflows/code-packages.yml` / `scripts/offline/scan-allowlist-code.json`：代码版升级 `my update --code [分支]`（默认 main），不发版也能让已安装的离线包更新到某分支最新代码，仍是 `app/<版本>/` + 原子切换 `current` + `update --rollback`，所以 `my` 始终是同一份。构建只能在 CI 里做（目标机器没有 git / npm，离线包自带的 node 只有 `bin/node`）：`code-packages.yml` 在 main 推送（先过 `ci.yml`）或手动触发时，用 `build-code.js` 一次 pack + `npm ci --omit=dev`、四个平台各配自己锁定的 Node，产出 `manyoyo-code-<sha7>-<系统>-<架构>-app.tar.gz` 与最后才上传的 `CODE.json`，放进该分支的滚动预发布 `code-<分支>`（`/` 换成 `--`，分支名规则与映射在 `lib/code-update.js`，CI 与客户端共用）。`CODE.json` 来自网络，客户端逐字段严格校验（资产名必须**等于**按提交与平台拼出的名字；含 `branch` 核对、`imageReady`：镜像还没发布就拒绝安装，否则 `update` 收尾会把 `imageVersion` 推到拉不到的镜像；它在构建时一次性写死，镜像晚发布要重跑 workflow 才会解除）；`CODE.json` 被 `gh release upload --clobber` 替换时有一小段“先删后传”的空窗，客户端遇到 404 会等 2 秒再确认一次；下载时服务端声明的大小与 `CODE.json` 不符就直接中止；`MANYOYO_TEST_CODE_BASE` 只给测试指向本地下载站替身。**不重复下载**：正式包（`build.js`）与代码版包（`build-code.js`）暂存的 `manyoyo/package.json` 都在 `npm ci` 之后写入 `gitHead`（构建提交，40 位小写 hex，取不到就让构建失败），客户端读 `app/current/manyoyo/package.json` 的 `gitHead`，等于 `CODE.json.commit` 就提示“就是当前正式版的代码”并返回；`.run` 安装出来的 `app/<版本>/` 里**没有** `manifest.json`（它在 `.run` 树根，安装脚本只搬 `app/`），所以按提交判断只能读 `package.json`（只对之后发布的正式版生效）。本地 `app/<代码版>/` 已有时直接切换（`switchInstalled`，与 `installFromArchive` 共用）：目录结构完整、manifest 的版本 / 类型 / 架构 / 系统 / `source.commit` 都对、`.installed` 等于 manifest 的哈希，缺一条就照常下载；判断顺序是 已是同版本 → 与正式版同提交 → 降级拒绝 → `imageReady` 拒绝 → 本地复用 → 下载（降级与镜像检查必须在本地复用之前，否则本地留着旧目录会绕过它们）；`onInfo` 在校验通过后、下载或切换之前打印“分支@提交 标题（构建于 本地时间）”。
- `lib/net-proxy.js`：访问 GitHub 的请求按请求读代理（环境变量 > macOS 系统代理，`https.Agent({ proxyEnv })`，Node ≥22.21 / ≥24.5），绝不改全局；`manyoyo update --file <app.tar.gz>` 安装手动下载的升级包（同目录 `SHA256SUMS` 必须校验通过）。
- `lib/app-update.js` / `update-check.js` / `download-verified.js`：离线包安装的增量升级（查最新 Release（跟随 `releases/latest` 跳转、升级包地址按固定命名拼出，不调 GitHub API：匿名 API 按 IP 限流，共享出口和 CI runner 经常撞上）→ 只下 `-app.tar.gz` 并校验 → `app/<版本>/` + 原子切换 `current` + 保留上一版本 + `update --rollback`，npm 安装不经过这里）、serve 每天最多一次的新版本检查（`updateCheck` 可关，请求不带本机信息，结果走 `GET /api/system/update`）、带 SHA256 校验的下载。升级包命名约定：`manyoyo-<ver>-<os>-<arch>-app.tar.gz` 与单一校验清单 `SHA256SUMS`（`os` 为 `macos` 或 `linux`，包内 manifest 的 `os` 字段会被校验；这两个名字已安装的 8.0.1 客户端按名查找，不能改），必须上传到 GitHub Release；Release 里是 4 个 `.run`、4 个 `-app.tar.gz`、1 个 `SHA256SUMS` 共 9 个资产；Intel 完整包超过 2 GiB 时 `.run` 分卷成 `.run.001/.002…`，所以资产数以 `SHA256SUMS` 为准（控制台按“清单与资产完全一致”判断，不写死个数；`release-offline.yml` 一次运行合并上传四个平台，没有精简包与 `release-manifest`）。macOS 升级包的 `manifest.json` 带 `runtime: { podmanVersion, vmDiskSha256 }`，`manyoyo update` 据此提示是否需要换完整包。
- `lib/headless.js` / `setup-cli.js` / `setup-config.js`：有头/无头判定（安装器与无参 `manyoyo` 共用，`--headless`/`--gui`/`MANYOYO_HEADLESS`）、无头环境的命令行配置向导 `manyoyo setup`（输入不回显、非 TTY 不挂起）、向导写配置的文本构造（与 `/api/setup/*` 同源，写入走 `lib/secure-file.js`）。命令行向导的步骤、用词与网页向导保持一致（第 1/4 步选 Agent → 接入方式（Base URL → Key → 模型）→ 工作目录 → 密码），提示默认项写“[默认选N]”。
- `lib/provider-presets.js`：向导里「兼容服务」的服务商预设，网页与命令行共用的唯一数据源（经 `lib/setup.js` 的 `listSetupAgents().providers` 下发）。收录标准：Base URL 不带 Key 请求得 401（智谱把鉴权失败写在 200 响应体里）且官方文档给了接入方式；`models` 只做占位，`defaultModel` 仅限官方要求必填的（DeepSeek）。Codex 条目只收文档确认支持 Responses 的（智谱、Kimi、火山、MiniMax）。**Codex 0.160 / 0.164 实测不认环境变量 `OPENAI_BASE_URL`（只认 `-c openai_base_url=`）**，向导写的仍是环境变量，所以执行 codex 的命令都要经 `lib/agent-adapters` 的 `withCodexBaseUrl`，在容器里由 shell 把它展开成 `-c`（网页对话、连接测试、CLI 交互运行三处；值不拼进命令文本）；新增执行 codex 的入口时别漏了它。
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
- `scripts/release/`：发布控制台（维护者工具，不进 npm 包），**唯一的发布入口**，三种方式：(a) 网页手动分步（`npm run release`，`127.0.0.1:3900`，令牌 + Host/Origin 校验，只能选固定阶段、不能提交任意命令）；(b) 网页“一键发布”（确认框只显示版本、提交列表和自动生成的说明，点一次“开始”）；(c) 命令行 `npm run release -- --remote`（agent 用，`--status [--json]` / `--notes-draft` / `--run <阶段,…> [--yes]` / `--remote [--version x.y.z] [--watch]` / `--remote-status [runId]`，`--help` 有完整用法）。(b)(c) 共用 `remote.js`（要在 main 上、工作区干净；版本没升就按推荐升并提交“升级版本到 x.y.z”→ 推送 main → `gh workflow run release-pipeline.yml`），之后全程在 GitHub Actions 里跑，可以关机；`--remote` 本身就是授权，不需要 `--yes`，其余对外动作仍须 `--yes`（否则只打印命令并以退出码 2 结束）。(a) 的状态完全由 git / GitHub / npm 的真实状态推出（`facts.js` → `stages.js`，阶段 preflight → … → npm，没有任何需要人勾选的阶段），可随时中断续跑；阶段执行在 `actions.js`，任务执行器 `jobs.js`（single / 逐步确认 step / 一次确认 auto；相邻同组阶段 verify ∥ npm 并行），`lock.js` 是网页与命令行共用的跨进程单实例锁（持有者 pid 已死则接管）。日志按阶段分文件：本地 `job-log.js` 写 `.release/logs/<时间>-<阶段>/NN-<阶段>.log` + `summary.json`（只留最近 20 次，`latest` 记录最近一次的目录名），远端 `pipeline-report.js` 在流水线的 summary job 里生成 artifact `release-report`（`release-summary.json`，保留 30 天；**不含失败日志**：运行还没结束时接口读不到这次运行里 job 的日志，summary job 里拉到的是空的）；`--remote-status` 取回汇总后，对没成功的运行在本地用已结束运行的日志重新生成 `failed-<阶段>.log`（只截到最后一个 `##[error]`），再指出路径。Release 说明由 `notes.js` 全自动生成（中文更新内容 + 安装方式 + 一句固定的英文，排除合并 / `docs:` / 升版本提交），不再有人工编辑环节。页面源码在 `frontend/release.html` + `frontend/src/release/`，`npm run build:release` 构建成 `scripts/release/console.html`（已忽略，首次运行自动构建）。`--dry-run` 对外动作只打印命令（本地检查如 preflight 仍会真跑）。
- `lib/plugin/`：Playwright 插件，容器内浏览器只有四种模式（默认容器内 Xvfb 有头 / `headed` / `chrome` / `vnc`），同一时间一个。宿主机 `~/.manyoyo/plugin/playwright/current/` 以**目录**只读挂进容器 `/run/manyoyo-playwright/`，`config.json` 一律原子替换，切模式后已运行容器自动跟随（不要改回单文件挂载）；`fingerprint.js` 是指纹唯一数据源，`docker/res/playwright/{browser.json,stealth.init.js,env}` 由 `scripts/gen-playwright-res.js` 生成并有单测校验；浏览器是 Google Chrome stable + patchright-core（替换 `@playwright/cli` 自带的 playwright-core，去掉 CDP Runtime 痕迹）；语言时区靠进程原生环境变量（容器内由 `playwright-cli.sh` source 挂载目录里的 `env`，宿主机服务 spawn 时合并 `process.env`）而不是 contextOptions（只作用于页面、Worker 不一致）；注意 launchOptions.env 会**整体替换**进程环境，别用它传 TZ；镜像构建时（integrity 校验之后）把 patchright 客户端 12 处 `isolatedContext = true` 默认值 sed 成 `false`（否则 `eval` / `run-code` 在隔离世界执行、读不到页面全局变量），次数写在 Dockerfile 的 `ISOLATED_DEFAULTS` 并有单测对照，升级 patchright 必须复核；扩展不能再用 `--load-extension`（官方 Google Chrome 自 M137 起忽略它，Chrome 154 实测连 `DisableLoadExtensionCommandLineSwitch` 也无效），`playwright-server.js` 启动后经 CDP `Extensions.loadUnpacked` 加载（需 `--enable-unsafe-extension-debugging`，只在有扩展时加）；`chrome-policy.json` 关闭 Chrome 154 的 Local Network Access 检查（否则不安全页面经 `host.containers.internal` 访问宿主机服务时 fetch 被拦）；`playwright-relay.js`（chrome 中继，只放行带 token 的 upgrade）、`playwright-server.js`（宿主机/vnc 容器里的浏览器服务）、`playwright-probe.js`（真实探测）、`playwright-assets/`（vnc 镜像）；`buildContainerIntegration` 是 CLI run 与 Web 建会话共用的唯一入口，永远不能因 playwright 让 run 退出。Playwright 1.64 起浏览器服务只绑 loopback 时会校验 Host（非 localhost/127.0.0.1 一律 403），所以 headed 在所有平台监听 0.0.0.0 + token；rootless 运行时的发布端口在容器没起来时 TCP 也能连上，就绪/存活判断不能只看端口。
- `lib/container-state.js` / `container-exec.js` / `container-init.sh`：每容器一个状态目录 `~/.manyoyo/containers/<manyoyo.id>/`（`box/` 读写挂到 `/run/manyoyo/`：用户 `env`、`autostart.sh`；`sys/` 只读挂到 `/run/manyoyo-sys/`：`init.sh`、`managed.env`；`network.json` 等不挂进容器），按随机 id 而非容器名索引，删了重建同名容器不继承。容器 PID 1 是 `init.sh`（回收僵尸、响应 SIGTERM、网络规则就绪后跑自启动）。用户 env 不进容器配置，**所有进用户容器的 exec 必须经 `buildExecArgs`**（现读 managed.env + 环境变量文件（`env-files.json` 里的宿主机绝对路径，每次 exec 重新读）+ box/env，优先级依次升高；语法只有一种，见 `lib/env-text.js`，前端 `container-manage.ts` 与 `container-init.sh` 各有等价实现并用同一组语料测试；先过滤非法行再写 0600 临时 env 文件（值按字面量写出，docker/podman 不处理引号），调用方用完 `cleanup()`；`test/container-exec.test.js` 用 grep 断言 `bin/` 与 `server.js` 里没有裸 `['exec'`）。
- `lib/network-policy.js` / `container-network.js` / `egress-sidecar.js` / `egress-proxy.js` / `egress-denied.js` / `port-forward.js` / `network-endpoints.js` / `container-manage-options.js`：网络策略 v2（出站 / 入站规则表，v1 读取时转换）校验与 nft 生成（规则文本只由校验过的结构化数据生成）、用一次性 helper 容器（`--network container:<名>` + `NET_ADMIN`）把规则写进目标容器的 netns、域名规则的过滤代理（有启用的域名行就走它，任何模式；`manyoyo` 网络里的专用 sidecar 容器 `manyoyo-egress-<HOME 哈希>`，固定 IP + 固定 MAC，用镜像自带的 node 跑只读挂入的 `egress-sidecar-main.js` 等几个无依赖文件；按**来源 IP** 查 `~/.manyoyo/egress/data/clients.json` 认容器，认不出一律 403，不要账号密码、宿主机不监听端口，`clients.json` 存编译好的有序规则，被拒记录写进 `egress/denied/<id>.jsonl`，通配域名解析到宿主机 / 内网 / 元数据地址须另有允许行）、运行中端口暴露（`exec socat` 转发）、从创建时 env 推断 Agent 端点、`autostart` / `network` 配置字段合并。新容器默认加入 `manyoyo` bridge 网络，策略默认 `restricted`。
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

**容器生命周期**：新容器 PID 1 是 `lib/container-init.sh`（见项目结构），旧容器是 `tail -f /dev/null`；默认命令存储在容器标签 `manyoyo.default_cmd`；容器就绪等待采用指数退避 100ms→2000ms，最多 30 次。

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

- **代码版的 tag 固定指向仓库根提交、永不移动**：移动已有 tag 会让 `git fetch --tags` 以退出码 1 失败（实测“会覆盖现有的标签”），发布控制台多处执行 `git fetch --quiet origin --tags`（`scripts/release/server.js`、`cli.js`）。真实提交只记在 `CODE.json` 里；预发布不会成为 `releases/latest`、也不触发 `npm-publish.yml`（它跳过预发布），有测试守着这些前提。**不要在仓库里开启“不可变发布（immutable releases）”**（2026-10-23 实测为关闭），否则滚动预发布无法替换资产、代码版构建会失败；真要开启，改成每次构建新建 `code-<分支>-<sha7>` 并让客户端从 `releases.atom` 取最新。首次真实运行（v8.6.10）已证实：tag 在根提交、`gh release create --target <根提交 sha>` 可用、`releases/latest` 仍指向 `v*`、npm-publish 没被触发、runner 上匿名 `docker manifest inspect` 能判断 `imageReady`；预发布按 tag 日期（根提交）排序，在 Releases 列表里沉底，不打扰正式版。
- **代码版版本号是 `x.y.z+<sha7>`**：`lib/app-update.js` 的 `isAppVersion` 认 `x.y.z` 与 `x.y.z+<7 位 hex>`（`detectInstallMode`、`rollbackApp`、`pruneApps` 都用它，`fetchLatestRelease` 仍只认纯 `x.y.z`）；`compareVersions` 把同一 `x.y.z` 的代码版与正式版当相等（所以 serve 横幅不会天天提示新版本，新正式版发布后 `update` 正常升级）；包里 `manyoyo/package.json` 的 `version` 在 `npm ci` **之后**才改写（serve 的“旧版还在跑”检测按它比较）；`pruneApps` 除了当前与上一版本，还保留最新的纯正式版（连装几次代码版后仍能回到正式版）。已知边角：版本号已升、正式版还没出时装的代码版，若正式版是在更晚的提交上出的，`update` 会认为相等不升级，按提示重跑安装命令即可。
- `.run` 头里**不能用 `tail` 取负载**：macOS 自带的 `tail`（`-n`、`-c` 都一样）读 2GB 文件极慢（Intel runner 上 168–235 秒，用户机器上也一样），自校验和解包各读一遍；现在是同一个文件描述符里先 `dd` 读掉头部再 `cat`（4 秒）。实测同一个 2GB 文件：`shasum` 10–15 秒、`cat | shasum` 9–19 秒、`tail -c | shasum` 94–235 秒、`dd+cat | tar -xzf` 3–21 秒；Intel 完整安装 494 秒降到 39 秒。要优化安装时间先量各段，别凭直觉换哈希命令（`shasum` 与 `openssl` 相差不到一倍）。
- 安装脚本（`scripts/offline/install.sh`、`finish-import.sh`、`.run` 头）在 macOS 上由 bash 3.2 当 sh 执行：**变量名后紧跟中文/全角字符必须写 `${VAR}`**（否则 `set -u` 下直接崩溃，Linux 的 dash 复现不了），`test/installer.test.js` 有防回归。发布前必须在真实 macOS 新用户下跑一遍，容器里的测试覆盖不到。
- 清理镜像不要用 `rmi --force`：Podman 会连带删除正在使用该镜像的容器。安装器遇到已存在的私有 machine 不 `rm` 也不 `init`；`update` / `build` / 安装 / 卸载（`--yes`）都不得删除用户的旧容器。
- 发布产物（npm 包、离线包、镜像）只在 CI 构建并经 `scripts/scan-release-artifacts.js` 扫描：解不开/解包不完整的文件按“未扫描”失败，`--exclude` 必须 `^` 锚定，允许列表按具体文件放行（镜像里曾扫出 SSH 主机私钥）。
- 含凭据的配置写入统一走 `lib/secure-file.js`（0600、临时文件 + rename）；`manyoyo.json` 的任何新写入点都不要直接 `writeFileSync`。
- 镜像内容变化（新增系统包等）后，先检查 `scan-allowlist-image.json` 是否需要放行新的误报，再看产物体积：macOS Intel 完整包超过 2 GiB 会被分卷成 `.run.001/.002`，Release 资产数随之变化。
- 改了代码就要重新触发 `build-packages.yml`（macOS 与 Linux 四个平台一次构建）并在干净用户下重测；镜像（`ghcr.io/xcanwin/manyoyo:<imageVersion>`）只有 Dockerfile 或 `docker/` 变化才需要重发，且要先于离线包；`image-publish.yml` 不会覆盖已有 tag（docker/ 变了必须先升 `imageVersion`），非 main 的 ref 强制 `dryRun`。
- 发版（维护者）一律用发布控制台，不再手敲 gh 命令序列。**默认路径**：代码提交并合并到 main 之后，`npm run release -- --remote`（或网页“一键发布”）→ 打印流水线地址就可以关机；`--remote-status` 看结果。流水线 `release-pipeline.yml`（`concurrency: release`，不取消进行中的）：`prepare`（校验 sha 就是 main 最新提交且版本高于最近发布、判断是否要发镜像、生成说明）→ `test`（复用 `ci.yml`）∥ `image`（仅 ghcr 上没有该 `imageVersion` 时，复用 `image-publish.yml`）→ `draft`（`prepare` 之后立刻建 Release **草稿**，`--target` 钉在这个提交上，不创建 tag）→ `packages`（复用 `build-packages.yml`，传入 `draftTag`：前端只构建一次分发，四个平台各自打包、隐私扫描、Linux 冒烟安装，通过后**每个构建 job 直接把本平台的 `.run` / `-app.tar.gz` 上传到草稿**，并把 `SHA256SUMS-<os>-<arch>` 与每个文件的大小 `SIZES-<os>-<arch>.txt` 作为小 artifact 上传；`draftTag` 只存在于 `workflow_call`，单独手动触发 `build-packages.yml` 永远只产出 artifact、不上传）→ `finalize`（只下载 4 份小清单，合并成唯一的 `SHA256SUMS` 上传，再用 `assert-assets.js` 核对草稿里的资产：名字与清单一致、state 为 uploaded、大小与构建时记录的一致；`release-offline.yml` 不再被流水线调用、也没有 `workflow_call` 入口，只保留给修复时单独手动触发）→ `prepublish-verify`（下载草稿资产，走 `scripts/install.sh` + 本机静态服务，再网页冒烟：登录 → 建会话 → `echo ok` → 删除，再插件冒烟：`manyoyo playwright probe`（默认模式起一次性容器，真的打开页面读回标题，限时 6 分钟）；**失败就不公开**；网页冒烟的非 GET 请求要带 `X-Requested-With: XMLHttpRequest`，否则 CSRF 校验 403）∥ `smoke-macos`（两个 macOS 平台各自从草稿下载本平台的包做冒烟安装，只挡住 `publish`）→ `publish`（`assert-assets.js` 再核一遍后 `--draft=false`）→ `npm` ∥ `postpublish-verify`（复用 `release-verify.yml`：四平台游客验证 + 从上一版本升级 / 回滚 / 再升级）→ `summary`。可续跑：失败后 `gh run rerun --failed`，已完成的 job 不重跑，草稿 / 资产幂等。**草稿提前创建**：测试失败时草稿里可能已经带着资产，但 `publish` 要求 `test` 成功，所以不会公开；dryRun 结束时删除，正式运行失败时保留草稿，续跑复用（同一提交）或下一次运行删掉重建（别的提交）。非 main 的 ref 上强制 dryRun（做到公开前验证为止，草稿名 `v<版本>-dryrun-<run_id>` 并标预发布，结束删除）。**两条硬约束**：npm 的 trusted publisher 绑定的是 workflow 文件名，OIDC 里的 `workflow_ref` 是顶层调用方，所以 `npm-publish.yml` 不能被 `workflow_call`，只能由流水线用 `GITHUB_TOKEN` 做 `gh workflow run npm-publish.yml`（`workflow_dispatch` 与 `repository_dispatch` 是 `GITHUB_TOKEN` 触发事件时仅有的例外，需要 `actions: write`；`skipTests` 要同时给 `sha`，npm-publish 自己核对 tag 指向的提交与之一致，隐私扫描保留）；`GITHUB_TOKEN` 公开 Release 不会触发 `release: published`，所以不会重复发布（用个人令牌公开时仍会触发，`--npm-dispatch` 只在没触发时用）。**排障顺序**：先看 `release-summary.json`（远端 `--remote-status` 会下载到 `.release/logs/remote-<id>/`；本地看 `.release/logs/latest` 指向的目录里的 `summary.json`）→ 只打开失败阶段的日志（`failed-<阶段>.log` / `NN-<阶段>.log`）→ 需要更多上下文再 `gh run view --log-failed --job <id>`，不要把所有日志读进来。**手动路径**（方式 a，以及流水线本身坏了的时候）：`--status` → `--run version --version x.y.z` → `--run commit --files … --message …` → `git push -u origin <分支>`（需授权）后 `ci.yml` 在同一提交上通过，或本地 `--run preflight`（约 5 分钟）→ `--run merge,packages --yes`（镜像有变化先 `image`；`--yes` 授权的是该条命令里的全部对外阶段）→ `--run release,assets,publish,verify,npm --yes`。已不再有人工真机检查（发布前 / 发布后），验证全部由流水线完成；macOS 虚拟机的自动验证（实测）：`macos-15`（arm64，Apple M1 虚拟机）上 `podman machine start` 报 `vfkit exited unexpectedly`，无法验证，所以 arm64 的安装验证只能跳过虚拟机（`MANYOYO_TEST_SKIP_MACHINE=1`）；`macos-15-intel` 上能真实启动，`release-verify.yml` 的 `vm-intel` 任务（不阻断）完整安装、启动私有虚拟机、导入镜像并跑一个容器（Intel 上 Podman 只有 5.8.x，brew 没有 bottle，要用官方 pkg）。arm64 的虚拟机启动、浏览器向导、Agent 对话没有自动化，改到这些区域的版本发布后维护者自己抽查。`image` 与 `test` 并行（计划的设计，不让需要发镜像时关键路径变长）：测试失败时镜像 tag 可能已经推出，之后修复若动了 `docker/` 必须升 `imageVersion`（`prepare` 守卫：`docker/` 变了而 `imageVersion` 没升就拒绝）。流水线里每个 job 的 `if` 都显式判断上游 `result == 'success'`（GitHub 会把“上游被跳过”沿依赖链传下去，光靠 `success()` 会在镜像 job 被跳过时让 draft 起整条链被跳过，而 run 的结论还是 success；`!failure()` 又会在 test 失败时放行）。发布前测试失败只需删草稿（dryRun 自动删）；已公开的 Release 与 npm 版本不删，前进修复。已安装的 ≤8.6.3 版本查最新版本仍走 GitHub API，所以“旧版升级”验证里 `update` 可能被限流：重试 3 次，仍不行用 `update --file` 完成并标成警告。
- 新 workflow 文件在合并到默认分支前无法 `workflow_dispatch`：要在分支上实测，临时给它加 `on: push: branches: [<分支>]` + `paths: [<一个专用触发文件>]`（改一下这个文件再推送就触发，不会被普通推送误触发），测完连同触发文件、实验用 workflow 一起删掉，`test/release-pipeline-workflow.test.js` 断言交付时没有残留；已存在于 main 的 workflow（如 `image-publish.yml`）可以 `gh workflow run … --ref <分支>`。被 `workflow_call` 复用的 workflow 里，调用方的 `permissions` 是上限（要发镜像，调用 job 必须授予 `packages: write`）；复用 workflow 里的 job 名在 API 里是 `<调用方 job id> / <job 名>`，汇总按前缀归成阶段。
- 镜像内容变化后本地预扫：`npm run scan:image -- ghcr.io/xcanwin/manyoyo:<ver>`（不带 `--auto-identity`，本机用户名会在 libgcrypt 里命中 `build-identity` 误报），比等 CI 才发现允许列表缺项省一轮；`build-packages.yml` 的镜像扫描结果按“镜像 ID + 允许列表 + 扫描器”哈希缓存。

## 开发流程踩坑（踩过才知道）

- 全新检出先 `npm run build:web`（生成 `lib/web/index.html`）再 `npm test`，否则 Web 页面用例失败；CI 的 `npm-publish.yml` 已先构建。
- 用脚本/工具整文件重写 `.sh` 会丢可执行位：提交前看 `git diff --cached --summary`，不应出现 `mode change`。
- 文档：frontmatter 的 `description` 含英文冒号加空格必须加引号，正文里裸 `<name>` 会被当 Vue 标签，须放进反引号；否则 `docs:build` 报错。移动页面先登记 `redirects.json`，再跑 `npm run docs:check`。
- 测试隔离：Jest 里改 `process.env.HOME` 不影响 `os.homedir()`；会写 `~/.manyoyo` 的代码路径（含插件状态、`web-server-*.test.js`）必须显式注入临时 `homeDir`，否则会污染开发者真实目录。`manyoyo build` 会把 `imageVersion` 写回真实 `~/.manyoyo/manyoyo.json`，本地验证后记得还原。
- CLI 端到端测 `update`（含 `--code`）要隔离两样东西：本机代理变量（否则访问 127.0.0.1 替身的请求被代理接走，见 `test/code-update.test.js` 的 `cleanEnv`）和容器运行时（升级收尾会检查 / 拉取镜像，PATH 里放一个假 `docker`）。podman 容器里访问宿主机上的替身用 `--network host --http-proxy=false`（podman 默认把宿主机代理变量注入容器）。
- 测试里起本进程的 HTTP 替身时，被测子进程必须异步 `spawn`；`spawnSync` 会卡住替身，表现为无输出超时。兼容性回归用仓库内 fixture（`test/fixtures/`），不要依赖 git tag（CI 浅克隆拿不到）。
- 改 workflow 后先用 `python3 -c "import yaml; yaml.safe_load(open('<文件>'))"` 校验语法；`set -e` 下 `! cmd` 不会失败，检查“不存在”要写 `if cmd; then exit 1; fi`。
- 开发容器若 PID 1 是 `tail -f /dev/null`，孤儿进程不会被回收，僵尸耗尽 cgroup 的 pids 上限后测试随机报“无法创建线程”/`spawn EAGAIN`；这时用 `docker run --rm -v "$PWD:$PWD" -w "$PWD" node:22-bookworm bash -lc '<命令>'` 在干净容器里验证，并让维护者重启容器。不要用 `pkill -f` / `pgrep -f` 匹配带自己命令行的模式，会杀掉自己的 shell。
- **Node 内置 `fetch` 不读 `HTTP(S)_PROXY`**：访问外网（GitHub）的请求必须经 `lib/net-proxy.js`；serve 进程里还有访问本机 / 容器的请求，**禁止**调用 `http.setGlobalProxyFromEnv()` 或设全局 `NODE_USE_ENV_PROXY`。已安装的旧版本（≤8.3.3）升级仍走旧代码，用户可临时 `NODE_USE_ENV_PROXY=1 my update`。
- 机器上同时装了 docker 和 podman（如 CI 的 ubuntu）时，集成测试和被测代码必须用同一套运行时选择（`selectContainerRuntime`，docker 优先），否则镜像导进 podman、脚本却去 docker 找。子 agent 的 worktree 若放在仓库内（`.claude/worktrees/`）要用完即合并删除；jest 已忽略 `.claude/`，但子 agent 写在 worktree 里的 `temp/` 反馈会随 worktree 一起丢，让它写主检出的绝对路径。
- Claude Code 的 hook 跑在独立会话里，**没有控制终端**（`/dev/tty` 打不开），stdout 又会被 Claude 截走，所以想让终端响铃、改标题，只能让 hook 输出 `{"terminalSequence":"\u0007"}`（只允许 BEL 和 OSC 0/1/2/9/99/777，只在用户级 / 托管设置里生效）。dash 下 `: > /dev/tty` 失败会让整个 shell 以 2 退出，而 Stop hook 退出码 2 表示阻止停止，Claude 会反复重跑；镜像里的响铃 hook 用 `CLAUDE_CODE_ENTRYPOINT = cli` 判断交互模式，网页的 `-p` 模式（`sdk-cli`）直接退出。
- podman 4.9 单参数 `podman untag <名:标签>` 会去掉该镜像的**所有**标签；只想去掉一个别名时用 `podman rmi <名:标签>`（不带 `--force`）。2.1.x 及更早的镜像里没有 `nft`，一次性 helper 不能只用目标容器自己的镜像。
- 子 agent 批量精简文档后，必须抽查事实（命令、参数、默认值以代码为准），删掉其自述“未核实”的新增内容。
- 推送、合并 main、触发 workflow、发 Release/npm 等对外动作，**即使已有 git/gh 凭据，也必须先得到用户明确授权**，授权只对当次指定的动作有效。获授权后若环境没配 git 凭据，可用 `git -c credential.helper='!gh auth git-credential' push origin <分支>`。发布后几分钟内 `npm view` 可能仍是旧版本，甚至在新旧版本间来回跳（CDN 节点同步有先后）：以 npm-publish 日志里的 `+ @xcanwin/manyoyo@<版本>` 为准，连续多次读到新版本才算可见（发布控制台就是这么判断的）。

- 容器重启后 netns 重建，**nft 规则全部丢失**：每次启动后必须重新下发（CLI `ensureReady` / Web `ensureWebContainer` / serve 订阅 `events`）。`/run/manyoyo-gate/ready`（tmpfs，重启即清）是“本次启动已下发”的门闩，没有它 init 不跑自启动、manyoyo 也不往里 exec（失败即关闭）。创建路径调用 `apply(name, { expectId })`：找不到刚建的容器必须报错，不能当旧容器放过。规则不能由容器可写的文件（如 `/run/manyoyo/env`）推导，否则容器能改自己的防火墙。
- 改容器创建流程会牵动测试替身：Web 单测注入 `networkManager`（见 `test/web-server-*.test.js` 的 `fakeNetworkManager`），CLI 假 docker 脚本要实现 `ps -q` / `inspect --format {{json .}}` / `run --label manyoyo.id`；集成测试 helper 走真实路径，宿主机上的夹具端口要用 `hostPorts` 放行。嵌套验证 docker / podman 5：在特权 `docker:dind` / `quay.io/podman/stable` 里 `-v /tmp:/tmp`（bind 源路径必须两边一致，且 `TMPDIR=/tmp`），用 `podman unshare nsenter -t <pid> -n` 让宿主机的 jest 进嵌套容器的网络命名空间，docker 客户端用 `DOCKER_HOST=tcp://127.0.0.1:2375`。

- 网络集成测试（`test/integration/container-network*.test.js`）：一个测试文件只起**一个** HOME 的 sidecar——sidecar 固定 IP 按 HOME 哈希只错开 5 个槽位，两个 HOME 同时在 `manyoyo` 网络里有 sidecar 会 20% 撞地址（还有 podman CNI 释放租约的延迟）；模拟“运行时注入代理”要给运行时子进程**清掉本机已有的代理变量再注入**（`http_proxy=true` 会让本机变量盖过 `containers.conf` 的 env），夹具代理 / HTTP 服务必须监听 `0.0.0.0`。前端比较“是否有未保存修改”不要用 `JSON.stringify` 比对象（服务端与界面里改过的规则键顺序不同，会一直显示未保存）。

- 过滤代理 sidecar 按来源 IP 认容器，前提是容器伪造不了来源：`buildContainerRunArgs` 统一 `--cap-drop NET_RAW`（docker 默认带，podman 没有），nft 另有“发往 sidecar 且源地址不是自己就丢弃”；sidecar 要固定 IP **和** MAC（只固定 IP 时重启后 ARP 缓存让出网断约一分钟），rootful 下要 `--cap-add DAC_OVERRIDE`（`--cap-drop ALL` 后 root 读不了用户的 0700 目录，rootless 与嵌套 dind 都测不出来）；sidecar 的重建版本号只含程序文件（上游代理写 `upstream.txt` 热更新），否则 CLI 与 serve 环境不同会互相删重建；凡是按名字 / 镜像列容器的地方都要用 `isSidecarName` 排除它。嵌套 dind 重启要 stop + start（`restart` 会因 containerd 残留 pid 起不来）；docker 的 `rm` 没有 `-t`。

## 版本对齐

- 镜像版本读取 `package.json` 的 `imageVersion`（格式 `x.y.z-variant`），与 `version` 字段独立。
- `test/doc-example-version.test.js` 扫描 `README.md` 与 `docs/**/*.md`（排除 `docs/.vitepress/`），所有 `x.y.z-后缀` 镜像版本示例必须与 `package.json.imageVersion` 同主版本，改 `imageVersion` 后不同步会导致 `npm test` 失败；确需保留的历史示例写进该测试的 `ALLOWED_HISTORICAL_VERSIONS` 白名单（文件 + 版本 + 原因），默认为空。
- `README.md` 的快速开始与主流程示例须与 `version` / `imageVersion` 对齐；`docs/`、`docs/en/` 的历史/场景示例可用其他版本，但必须保持 `x.y.z-后缀` 格式并标注用途。
- `package.json.playwrightCliVersion` 是 Playwright CLI 版本的单一来源；镜像内安装 `@playwright/cli` 时禁止改回 `@latest`（`update-agents.sh` 也不能把它升到 latest），也不要误用 `dependencies.playwright` 作为版本来源。`patchrightCoreVersion` / `patchrightCoreIntegrity` 是 patchright-core 的版本与 integrity 单一来源：它必须与 cli 自带 playwright-core **同 minor**（单测里的对照表 + Dockerfile 构建期断言），升级时在干净的 `node:24-bookworm` 容器里从源码复现 tarball：clone `Kaliiiiiiiiii-Vinyzu/patchright@<版本 tag>`（含子模块 `patchright-nodejs`）和同版本的 `microsoft/playwright`，按它 CI 的目录布局摆放（`playwright/` 在 patchright 仓库根下；布局不对时 `npm run patch` 会静默跳过补丁，产物看着正常却缺内容）。先 `set -o pipefail`，再按它的 release workflow 依次执行 `npm run patch` → `generate_channels` → `npm run build` → `patchright_rebranding.ts` → `npm pack`（约 1 分钟）。产物的 sha512 必须与 npm registry 上的 integrity 完全一致，不一致不得采用。
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
