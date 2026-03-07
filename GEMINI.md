# MANYOYO 项目 Gemini CLI 上下文

本文件为 Gemini CLI 在 MANYOYO 项目中工作时提供全面的上下文和指令。

## 开发者偏好与交互风格 (CRITICAL)

*   **语言：** 请全程使用 **中文** 与用户沟通。
*   **语气：** 简洁、直接、高信噪比。避免过多的客套话和废话。
*   **代码改动原则：**
    *   **最小化改动：** 仅修改解决问题所必须的代码，**严禁**顺手重构无关代码或进行无关的格式化。
    *   **不自动提交：** 除非用户明确指令（如 "commit 这次改动"），否则**不要**自动执行 `git commit`。
    *   **方案选择：** 当有多种方案时，提供清晰的选项让用户选择，避免开放式的来回确认。
*   **承诺：** 不要提供时间预估或承诺完成时间。

## 项目概览

**MANYOYO (慢悠悠)** 是一款 AI 智能体 CLI 安全沙箱。它是一个基于 Node.js 的 CLI 工具，利用 Docker 或 Podman 创建隔离环境（沙箱），用于运行 Claude Code、Gemini、Codex 和 OpenCode 等 AI 智能体。它支持这些智能体的 "YOLO" (You Only Look Once) 模式，在容器内安全地绕过权限检查。

**核心技术：**
*   **运行时：** Node.js (>= 22.0.0)
*   **容器化：** Docker 或 Podman
*   **文档：** VitePress
*   **测试：** Jest
*   **Web 服务器：** WebSocket + xterm.js (用于 Web 终端访问)

## 目录结构与架构

*   **`bin/manyoyo.js`**：主 CLI 入口点。处理参数解析 (Commander.js)、配置加载和高层编排。
*   **`lib/`**：核心逻辑模块。
    *   `container-run.js`：构建 Docker `run` 命令。
    *   `image-build.js`：Docker 镜像构建和缓存逻辑。
    *   `init-config.js`：智能体配置初始化（从本地智能体配置迁移）。
    *   `agent-resume.js`：智能体可以恢复会话的逻辑。
    *   `web/`：Web 服务器实现 (`server.js`) 和前端资源 (`frontend/`)。
    *   `plugin/`：插件系统（目前通过 `playwright.js` 支持 Playwright）。
*   **`docker/`**：
    *   `manyoyo.Dockerfile`：沙箱镜像的多阶段 Dockerfile。
    *   `cache/`：构建依赖的本地缓存（Node.js tarballs, LSP 服务器）。
*   **`docs/`**：双语文档（中文 `zh/` 和 英文 `en/`）。
*   **`test/`**：Jest 测试文件 (`*.test.js`)。

## 开发工作流

### 1. 安装与设置
*   **安装依赖：** `npm install` (CI/可复现构建请使用 `npm ci --include=optional`)。
*   **全局链接：** `npm link` 或 `npm run install-link` 以在本地测试 `manyoyo` 命令。

### 2. 测试（强制）
*   **框架：** Jest。
*   **运行所有测试：** `npm test` (包含覆盖率)。
*   **运行单元测试：** `npm run test:unit`。
*   **TDD 模式：**
    1.  **Red (红)：** 在 `test/` 中编写一个失败的测试用例。
    2.  **Green (绿)：** 实现最小代码以通过测试。
    3.  **Refactor (重构)：** 清理代码并确保测试通过。
*   **覆盖率：** 新功能必须有对应的测试。Bug 修复必须包含回归测试。

### 3. 文档
*   **结构：** 主要文档在 `docs/zh/`。`docs/en/` 中的英文翻译必须保持同步。
*   **构建：** `npm run docs:build` (检查死链接)。
*   **开发服务器：** `npm run docs:dev` (运行于 `localhost:5173`)。
*   **预览：** `npm run docs:preview`。

### 4. 构建镜像
*   **命令：** `manyoyo build --iv 1.8.1-common` (确保版本与 `package.json` 匹配)。
*   **缓存：** 系统会在 `docker/cache/` 中缓存依赖 2 天以加速构建。

## 配置系统

配置从三个来源合并（优先级从高到低）：
1.  **CLI 参数**：例如 `-y c`, `--env-file ...`
2.  **运行配置 (Run Configuration)**：定义在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` 下。
3.  **全局配置 (Global Configuration)**：`~/.manyoyo/manyoyo.json` 中的根字段。

**关键规则：**
*   **标量值 (Scalar Values)：** 覆盖 (后出现的生效)。
*   **数组 (`envFile`, `volumes`, `ports`)：** 追加/合并。
*   **对象 (`env`)：** 按键合并 (CLI 覆盖 Run 覆盖 Global)。

## 编码规范

*   **风格：** CommonJS (`require`/`module.exports`)。**不使用 ES Modules。**
*   **格式：** 4 空格缩进，必须使用分号。
*   **Linting：** `npm run lint` (目前主要作为占位符，依赖标准的 JS 最佳实践)。
*   **安全：**
    *   **输入验证：** 容器名称需符合严格正则 (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)。
    *   **路径安全：** 验证宿主机路径，防止挂载敏感目录如 `/` 或 `/home`。
    *   **命令注入：** 始终使用参数数组配合 `spawnSync`，绝不要拼接 Shell 字符串来执行涉及用户输入的命令。
    *   **机密信息：** 在日志/输出中对敏感数据（密钥/令牌）进行脱敏掩码。

## 贡献指引

*   **提交信息 (Commit Messages)：** 简练的中文动词短语（例如：`修复配置加载问题`, `docs: 更新安装指南`）。
*   **验证：**
    *   提交前始终运行 `npm test`。
    *   如果修改了文档，运行 `npm run docs:build`。
    *   验证 `manyoyo --version` 和 `manyoyo --show-config` 的行为。

## Agent 特别说明

*   **YOLO 模式：**
    *   `c` / `cc` -> Claude Code (安全模式: `IS_SANDBOX=1`)
    *   `gm` -> Gemini
    *   `cx` -> Codex
    *   `oc` -> OpenCode
*   **Web 服务器：** 在 `lib/web/server.js` 上工作时，请记住所有路由默认都需要身份验证，除非显式列入白名单。
