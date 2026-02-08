# Repository Guidelines

本指引面向本仓库贡献者，强调最小改动、可验证与文档双语一致性。若需添加功能，先明确范围与安全影响，再动手改代码。

## 协作偏好
- 主要使用中文沟通。
- 回复简洁实用，代码改动尽量最小化。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 未明确要求时不自动提交；需要时先给 commit message/命令。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目要点
- 项目：`manyoyo`（AI Agent CLI 安全沙箱）。
- 文档栈：VitePress（`npm run docs:dev|build|preview`）。
- 文档语言策略：中文主维护 `docs/zh/`，英文 `docs/en/`。
- 根目录历史中文页按需保留为兼容跳转页。
- 配置优先级：命令行参数 > 运行配置 > 全局配置 > 默认值。
- `--server` 网页模式采用全局认证网关；除登录路由外默认所有页面与接口都需认证。

## 项目结构与模块组织
- `bin/manyoyo.js`: CLI 入口与主流程编排（CommonJS）；参数解析、容器主流程优先就近维护。
- `lib/web/server.js`: `--server` 网页服务、全局认证网关与 API 路由。
- `lib/web/static/`: 网页静态资源（`app/login` 的 `html/css/js`）。
- `docker/manyoyo.Dockerfile` + `docker/cache/`: 镜像构建与缓存目录，涉及工具或镜像版本时更新。
- `docs/`: VitePress 文档；中文主目录 `docs/zh/`，英文 `docs/en/`；结构需保持一致。
- `test/`: Jest 测试，文件名 `*.test.js`（如 `test/manyoyo.test.js`）。
- `assets/` 与 `config.example.json`: 资源与配置模板。

## 目录速查
- `docs/zh/guide/` `docs/zh/configuration/` `docs/zh/reference/` `docs/zh/advanced/` `docs/zh/troubleshooting/`
- `docs/en/guide/` `docs/en/configuration/` `docs/en/reference/` `docs/en/advanced/` `docs/en/troubleshooting/`
- `lib/web/` `lib/web/static/`
- `docker/` `bin/` `test/` `assets/` `coverage/`

## 构建、测试与开发命令
- `npm install`: 开发阶段安装/更新依赖（会更新 `package-lock.json`）。
- `npm ci --include=optional`: 提交前与 CI 的可复现安装（CI 不再执行 `npm install`）。
- `npm test`: 运行全部测试并生成覆盖率（输出到 `coverage/`）。
- `npm run test:unit`: 仅跑 `test/` 下的单元测试。
- `npm run lint`: 占位的 lint 检查（不做风格约束）。
- `npm run docs:dev|build|preview`: 启动/构建/预览文档站点（先执行 `npm ci --include=optional`，再执行 `npm run docs:build`，不要并行）。
- `npm install -g .` / `npm link` / `npm run install-link`: 本地全局安装或软链 CLI。

## 编码风格与命名约定
- Node.js >= 22，CommonJS `require`/`module.exports`，四空格缩进，分号结尾。
- 不使用 ES Modules（`import` / `export`）。
- 选项与默认值集中在 `bin/manyoyo.js`；新增功能靠近相关分区。
- 命名清晰简短；测试文件遵循 `*.test.js`。
- 优先小步改动，避免无关重构，保持改动小、范围清晰。

## 测试规范
- 框架为 Jest（见 `package.json` 的 `jest` 配置）。
- 新增功能优先补充 `test/manyoyo.test.js` 的关键分支与异常路径。
- 修复 bug 时建议加入回归测试，并注明 case。
- 涉及网页服务认证时，至少验证未登录 `401`、登录成功可访问、登出后失效。

## TDD 模式
- 默认适用：新增功能、行为变更、bug 修复；纯文档改动可例外。
- Red：先写失败测试，优先在 `test/manyoyo.test.js` 用最小 case 复现问题。
- Green：只做最小代码改动让测试通过，避免顺手重构。
- Refactor：在测试持续通过前提下再整理命名或重复逻辑，确保行为不变。
- 开发阶段优先运行 `npm run test:unit`；提交前运行 `npm test`。
- 每个 bug fix 至少补一个回归用例（先失败后通过）；若无法先写失败测试，需在变更说明中写明原因与替代验证步骤。

## 提交与 PR 指引
- 历史提交以简短中文动词短语为主，文档常用 `docs:` 前缀。
- PR 需包含：变更摘要、测试结果（如 `npm test`）、相关文档更新说明。
- 文档改动同步更新 `docs/zh/` 与 `docs/en/`，保留兼容跳转页。

## 常见开发任务
- 配置合并验证：`manyoyo --show-config`，`manyoyo -r <name> --show-config`。
- 命令预览：`manyoyo -n test --show-command`，用于检查参数拼装。
- 环境文件解析：`manyoyo --ef <name> --show-config`。
- 容器调试：`manyoyo -n <name> -x /bin/bash`。
- 镜像构建：`manyoyo --ib --iv <version>`，可加 `--iba TOOL=common`。
- 网页认证登录：`curl --noproxy '*' -c /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"123456"}'`。
- 带认证访问接口：`curl --noproxy '*' -b /tmp/manyoyo.cookie http://127.0.0.1:3000/api/sessions`。
- 删除容器与聊天记录：`curl --noproxy '*' -b /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/api/sessions/<name>/remove-with-history`。

## 配置与路径提示
- 配置模板：`config.example.json`。
- 全局配置：`~/.manyoyo/manyoyo.json`（JSON5）。
- 运行配置：`~/.manyoyo/run/<name>.json`。
- 环境文件：`~/.manyoyo/env/<name>.env`。
- 网页认证配置：`serverUser`、`serverPass`（支持环境变量 `MANYOYO_SERVER_USER`、`MANYOYO_SERVER_PASS`）。
- 网页认证参数优先级：命令行参数 > 运行配置 > 全局配置 > 环境变量 > 默认值。
- 缓存目录：`docker/cache/`，覆盖率：`coverage/`。

## 环境与兼容性
- 运行环境：`node` >= 22，容器运行时支持 `podman` 或 `docker`。
- CLI 入口：`manyoyo` 与 `myy` 指向同一可执行文件。
- 发布检查：核对 `package.json` 的 `version` 与 `imageVersion` 是否匹配文档。
- 包含文件：`README.md` `LICENSE` `docker/manyoyo.Dockerfile` `config.example.json` 需与发布一致。
- 入口脚本：`bin/manyoyo.js` 变更时同步检查 `package.json` 的 `bin` 字段。
- 版本对齐：`IMAGE_VERSION` `IMAGE_VERSION_BASE` `imageVersion` 与文档示例保持一致。
- 文档版本：`docs/zh/` `docs/en/` 与 `README.md` 示例保持一致。

## 变更执行检查清单
1. 仅做最小且有针对性的改动。
2. 涉及文档改动时运行 `npm run docs:build`。
3. 检查 dead links 与 sidebar/nav 行为。
4. 反馈保持简洁，并附可选 commit 命令/message。

## 文档与安全提示
- 侧边栏在 `/zh/` 与 `/en/` 统一展示全章节导航；首页卡片需可点击跳转。
- 文档修改后运行 `npm run docs:build`，检查 dead links 与导航行为。
- 配置模板见 `config.example.json`；用户配置默认在 `~/.manyoyo/`。
- 新增配置项或 CLI 选项时，同步更新 `config.example.json`、`docs/zh/` 与 `docs/en/`；必要时同步 `README.md` 示例。
- 新增网页接口/页面时，默认走全局认证网关；仅登录相关路由允许匿名访问。
- 登录匿名放行路由需显式控制在 allowlist（当前为 `/auth/login` 与 `/auth/static/*`）；其余路由默认要求认证。
- 禁止在业务路由里零散补认证，优先在统一入口做认证兜底，避免后续漏校验。
- 新增容器模式或挂载选项时，不放宽安全校验。
- `sock` 容器模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 涉及命令执行时优先使用参数数组，避免拼接 shell 字符串；新增输出涉及敏感信息时需脱敏。
