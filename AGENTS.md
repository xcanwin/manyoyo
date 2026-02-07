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

## 项目结构与模块组织
- `bin/manyoyo.js`: 单文件 CLI 入口与核心逻辑（CommonJS）。改动尽量就近、可读，避免跨区重排。
- `docker/manyoyo.Dockerfile` + `docker/cache/`: 镜像构建与缓存目录，涉及工具或镜像版本时更新。
- `docs/`: VitePress 文档；中文主目录 `docs/zh/`，英文 `docs/en/`；结构需保持一致。
- `test/`: Jest 测试，文件名 `*.test.js`（如 `test/manyoyo.test.js`）。
- `assets/` 与 `config.example.json`: 资源与配置模板。

## 目录速查
- `docs/zh/guide/` `docs/zh/configuration/` `docs/zh/reference/` `docs/zh/advanced/` `docs/zh/troubleshooting/`
- `docs/en/guide/` `docs/en/configuration/` `docs/en/reference/` `docs/en/advanced/` `docs/en/troubleshooting/`
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

## 配置与路径提示
- 配置模板：`config.example.json`。
- 全局配置：`~/.manyoyo/manyoyo.json`（JSON5）。
- 运行配置：`~/.manyoyo/run/<name>.json`。
- 环境文件：`~/.manyoyo/env/<name>.env`。
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
- 新增容器模式或挂载选项时，不放宽安全校验。
- `sock` 容器模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 涉及命令执行时优先使用参数数组，避免拼接 shell 字符串；新增输出涉及敏感信息时需脱敏。
