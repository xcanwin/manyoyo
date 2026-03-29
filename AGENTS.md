# 仓库协作指引

本指引面向本仓库贡献者，强调最小改动、可验证与文档双语一致性。若需添加功能，先明确范围与安全影响，再动手改代码。

## 协作偏好
- 主要使用中文沟通。
- 回复简洁实用，代码改动尽量最小化。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能迭代时不保留、不兼容、不提示旧功能（除非明确要求）。
- 未明确要求时不自动提交；需要时先给 commit message/命令。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目要点
- 项目：`manyoyo`（AI Agent CLI 安全沙箱）。
- 文档栈：VitePress（`npm run docs:dev|build|preview`）。
- 文档语言策略：中文主维护 `docs/zh/`，英文 `docs/en/`。
- 根目录兼容页与历史页按需保留，兼顾旧链接跳转与当前文档导航。
- 配置合并规则：标量配置按“命令行参数 > runs.<name> > 全局配置 > 默认值”覆盖；数组配置（`envFile`/`volumes`/`imageBuildArgs`）按“全局配置 → runs.<name> → 命令行参数”追加合并；`env` 使用 map，按 key 合并覆盖（命令行参数 > runs.<name> > 全局配置）。
- `serve` 网页模式采用全局认证网关；除登录路由外默认所有页面与接口都需认证。

## 项目结构与模块组织
- `bin/manyoyo.js`: CLI 入口与主流程编排（CommonJS）；参数解析、容器主流程优先就近维护。
- `lib/container-run.js`: CLI/Web 共享的容器运行参数构造与命令展示。
- `lib/image-build.js`: 镜像构建、构建缓存准备与 build args 解析。
- `lib/agent-resume.js`: Agent 程序识别、resume 参数推断与提示词命令模板生成。
- `lib/log-path.js` + `lib/serve-log.js`: 日志路径分目录规则、`serve` 日志脱敏与进程快照工具。
- `lib/plugin/index.js` + `lib/plugin/playwright.js`: 插件命令分发与 Playwright 插件主逻辑（场景配置、容器/宿主启动链路）。
- `lib/plugin/playwright-assets/`: Playwright 容器场景 compose 与镜像资源模板。
- `docker/res/playwright/playwright-cli-wrapper.sh`: 容器内 `playwright-cli install-browser` 兜底包装脚本，确保浏览器安装到全局 `@playwright/cli` 自带的 Playwright。
- `lib/web/server.js`: `serve` 网页服务、全局认证网关与 API 路由。
- `lib/web/frontend/`: 网页前端资源（`app/login` 的 `html/css/js`）。
- 终端 vendor 资源（`/app/vendor/xterm.css`、`/app/vendor/xterm.js`、`/app/vendor/xterm-addon-fit.js`）由 `lib/web/server.js` 从 `@xterm/*` 依赖映射提供。
- `docker/manyoyo.Dockerfile` + `docker/cache/`: 镜像构建与缓存目录，涉及工具或镜像版本时更新。
- `docker/res/`: 各 Agent 默认配置、Playwright 资源与 supervisor 模板。
- `docs/`: VitePress 文档；中文主目录 `docs/zh/`，英文 `docs/en/`；结构需保持一致。
- `test/`: Jest 测试，文件名 `*.test.js`（如 `test/manyoyo.test.js`、`test/web-server-auth.test.js`）。
- `assets/` 与 `manyoyo.example.json`: 资源与配置模板。

## 目录速查
- `docs/zh/guide/` `docs/zh/configuration/` `docs/zh/reference/` `docs/zh/advanced/` `docs/zh/troubleshooting/`
- `docs/en/guide/` `docs/en/configuration/` `docs/en/reference/` `docs/en/advanced/` `docs/en/troubleshooting/`
- `docs/guide/` `docs/configuration/` `docs/reference/` `docs/advanced/` `docs/troubleshooting/`
- `lib/web/` `lib/web/frontend/`
- `docker/` `bin/` `test/` `assets/` `coverage/`

## 构建、测试与开发命令
- `npm install`: 开发阶段安装/更新依赖（会更新 `package-lock.json`）。
- `npm ci --include=optional`: 提交前与 CI 的可复现安装（CI 不再执行 `npm install`）。
- `npm test`: 运行全部测试并生成覆盖率（输出到 `coverage/`）。
- Jest 已忽略 `temp/` 工作目录，避免本地研究目录或临时副本干扰测试扫描。
- `npm test` 也会执行入口文档示例版本检查（当前覆盖 `README.md`、`quick-start`、`basic-usage`、`cli-options`），要求其示例版本与 `package.json.imageVersion` 保持同一主版本号。
- `npm run test:unit`: 仅跑 `test/` 下的单元测试。
- `npm run lint`: 占位的 lint 检查（不做风格约束）。
- `npm run docs:dev|build|preview`: 启动/构建/预览文档站点。提交前或文档校验时先执行 `npm ci --include=optional`，再执行 `npm run docs:build`（不要并行）。
- `npm install -g .` / `npm link` / `npm run install-link`: 本地全局安装或软链 CLI。

## 编码风格与命名约定
- Node.js >= 22，CommonJS `require`/`module.exports`，四空格缩进，分号结尾。
- 不使用 ES Modules（`import` / `export`）。
- 选项与默认值集中在 `bin/manyoyo.js`；新增功能靠近相关分区。
- 命名清晰简短；测试文件遵循 `*.test.js`。
- 优先小步改动，避免无关重构，保持改动小、范围清晰。

## 测试指引
- 框架为 Jest（见 `package.json` 的 `jest` 配置）。
- 新增功能优先补充对应领域测试文件的关键分支与异常路径（CLI 优先 `test/manyoyo.test.js`，Web 优先 `test/web-server-auth.test.js`）。
- 插件相关改动优先补充 `test/plugin-command.test.js`，至少覆盖 host/container 两类场景的关键分支（配置生成、参数透传、挂载或启动路径）。
- 修复 bug 时建议加入回归测试，并注明 case。
- 涉及网页服务认证时，至少验证未登录 `401`、登录成功可访问、登出后失效。

## TDD 模式
- 默认适用：新增功能、行为变更、bug 修复；纯文档改动可例外。
- Red：先写失败测试，按变更领域选最小 case（CLI 优先 `test/manyoyo.test.js`；Web 优先 `test/web-server-auth.test.js`）。
- Green：只做最小代码改动让测试通过，避免顺手重构。
- Refactor：在测试持续通过前提下再整理命名或重复逻辑，确保行为不变。
- 开发阶段优先运行 `npm run test:unit`；提交前运行 `npm test`。
- 每个 bug fix 至少补一个回归用例（先失败后通过）；若无法先写失败测试，需在变更说明中写明原因与替代验证步骤。

## 提交与 PR 指引
- 历史提交以简短中文说明为主，优先使用动词短语；确需补充背景时再追加精简摘要，文档改动常用 `docs:` 前缀。
- PR 需包含：变更摘要、测试结果（如 `npm test`）、相关文档更新说明。
- 文档改动同步更新 `docs/zh/` 与 `docs/en/`，保留兼容跳转页。

## 常见开发任务
- 配置合并验证：`manyoyo config show`，`manyoyo config show -r <name>`。
- 命令预览：`manyoyo config command -r <name>`，用于检查参数拼装。
- 快速迁移已有 Agent 配置：`manyoyo init all`，然后 `manyoyo run -r claude`（或 `codex/gemini/opencode`）。
- 动态容器名验证（`{now}`）：在运行配置写 `containerName: "my-<agent>-{now}"`，执行 `manyoyo config show -r <name>` 查看解析结果。
- 环境文件解析：`manyoyo config show --ef /abs/path/myenv.env`。
- 容器调试：`manyoyo run -n <name> -x /bin/bash`。
- 镜像构建：`manyoyo build --iv <x.y.z-后缀>`（如 `1.8.4-common`），可加 `--iba TOOL=common`。
- 局域网监听网页服务：`manyoyo serve 0.0.0.0:3000 -U <user> -P <pass>`。
- 网页认证登录：`curl --noproxy '*' -c /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/auth/login -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<pass>"}'`（需与启动参数/配置一致）。
- 若未显式设置 `-P/--pass`（或 `serverPass` / `MANYOYO_SERVER_PASS`），系统会在启动时生成随机密码并打印到终端。
- 带认证访问接口：`curl --noproxy '*' -b /tmp/manyoyo.cookie http://127.0.0.1:3000/api/sessions`。
- 删除对话历史（保留容器）：`curl --noproxy '*' -b /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/api/sessions/<name>/remove-with-history`。

## 配置与路径提示
- 配置模板：`manyoyo.example.json`。
- 全局配置：`~/.manyoyo/manyoyo.json`（JSON5）。
- 运行配置：`~/.manyoyo/manyoyo.json` 的 `runs.<name>`（通过 `run/config show/config command -r <name>` 按名称读取）。
- 环境文件：`run/config show/config command` 的 `--ef/--env-file` 与 `envFile` 仅支持绝对路径（如 `/abs/path/name.env`）。
- 初始化配置：`manyoyo init [agents]` 会写入 `~/.manyoyo/manyoyo.json` 的 `runs.<agent>`（含 `env` map）。
- 初始化覆盖行为：目标 `runs.<name>` 已存在时逐个询问；`manyoyo init ... --yes` 会自动覆盖。
- 网页认证配置：`serverUser`、`serverPass`（支持环境变量 `MANYOYO_SERVER_USER`、`MANYOYO_SERVER_PASS`）。
- 网页服务监听：`serve [listen]` 仅支持 `<ip:port>`（IPv6 写作 `[ip]:port`），默认 `127.0.0.1:3000`。
- 网页认证参数优先级：命令行参数 > 运行配置 > 全局配置 > 环境变量 > 默认值。
- 镜像版本格式：`imageVersion` 与 `run/build --iv/--image-ver` 必须为 `x.y.z-后缀`（如 `1.8.1-common`）。
- `--yes` 仅用于 `build` 与 `init` 子命令。
- CLI 仅支持子命令入口；传入未定义参数会报 `unknown option`。
- 缓存目录：`docker/cache/`，覆盖率：`coverage/`。
- 日志目录 `~/.manyoyo/logs/` 下新增文件时，必须按子命令、功能或业务场景分目录（如 `serve/`、`build/`、`run/`），不要直接堆在根目录。

## 环境与兼容性
- 运行环境：`node` >= 22，容器运行时支持 `podman` 或 `docker`。
- CLI 入口：`manyoyo` 与 `my` 指向同一可执行文件。
- 发布检查：核对 `package.json` 的 `version` 与 `imageVersion` 是否匹配文档。
- Playwright CLI 版本单一来源为 `package.json.playwrightCliVersion`；镜像内安装 `@playwright/cli` 时禁止改回 `@latest`，也不要误用 `dependencies.playwright` 作为其版本来源。
- 包含文件：`README.md` `LICENSE` `docker/manyoyo.Dockerfile` `manyoyo.example.json` 需与发布一致。
- 入口脚本：`bin/manyoyo.js` 变更时同步检查 `package.json` 的 `bin` 字段。
- 版本对齐：`IMAGE_VERSION` `IMAGE_VERSION_BASE` `imageVersion` 与文档示例保持一致。
- 文档版本：`docs/zh/` `docs/en/` 与 `README.md` 示例保持一致。

## 变更执行检查清单
1. 仅做最小且有针对性的改动。
2. 涉及文档改动时运行 `npm run docs:build`。
3. 检查 dead links 与 sidebar/nav 行为。
4. 反馈保持简洁，并附可选 commit 命令/message。
5. 校对版本示例：`README.md` 的快速开始与主流程示例应与 `package.json` 的 `version` / `imageVersion` 对齐；`docs/zh/`、`docs/en/` 的历史/场景示例可使用其他版本，但必须保持 `x.y.z-后缀` 格式并标注用途。

## 文档与安全提示
- 侧边栏在 `/zh/` 与 `/en/` 统一展示全章节导航；首页卡片需可点击跳转。
- 当前 `docs/`、`docs/configuration/`、`docs/troubleshooting/` 及 `docs/zh|en` 下对应目录首页使用 `README.md`；新增目录首页优先使用 `README.md`，不再新增 `index.md`。
- 文档内部链接优先使用仓库相对 `.md`/`README.md` 路径，保证 GitHub 网页浏览可直接跳转；站点路由由 VitePress 兼容。
- 文档修改后运行 `npm run docs:build`，检查 dead links 与导航行为。
- 配置模板见 `manyoyo.example.json`；用户配置默认在 `~/.manyoyo/`。
- 新增配置项或 CLI 选项时，同步更新 `manyoyo.example.json`、`docs/zh/` 与 `docs/en/`；必要时同步 `README.md` 示例。
- 新增网页接口/页面时，默认走全局认证网关；仅登录相关路由允许匿名访问。
- 调整容器内 Playwright CLI 浏览器安装链路时，必须保证 `playwright-cli install-browser` 安装到全局 `@playwright/cli` 自带的 Playwright，而不是仓库本地 `node_modules/playwright`。
- 登录匿名放行路由需显式控制在 allowlist（当前为 `/auth/login`、`/auth/logout`、`/auth/frontend/login.css`、`/auth/frontend/login.js`）；其余路由默认要求认证。
- 禁止在业务路由里零散补认证，优先在统一入口做认证兜底，避免后续漏校验。
- 网页前端默认避免常驻高开销视觉效果：不要在常驻元素使用 `animation: ... infinite`，避免大面积叠加 `backdrop-filter` / `filter` 模糊；确需使用时仅限短时场景，并提供 `prefers-reduced-motion` 降级。
- 当使用 `serve 0.0.0.0:<port>` 对外监听时，必须设置强密码，并通过防火墙限制访问来源。
- 新增容器模式或挂载选项时，不放宽安全校验。
- `sock` 容器模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 涉及命令执行时优先使用参数数组，避免拼接 shell 字符串；新增输出涉及敏感信息时需脱敏。
