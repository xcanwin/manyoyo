# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。项目主要使用中文文档，附带英文翻译。

**核心特性：**
- 单文件 Node.js CLI 工具（`bin/manyoyo.js`），依赖极少
- 多阶段 Docker 构建，智能缓存 Node.js、JDT LSP 和 gopls
- 配置级联：命令行参数 > 运行配置 > 全局配置 > 默认值
- 安全优先设计：路径验证、敏感数据脱敏、容器隔离模式

## 项目结构

```
manyoyo/
├── bin/
│   └── manyoyo.js           # 单文件 CLI 入口与核心逻辑（CommonJS）
├── docker/
│   ├── manyoyo.Dockerfile   # 镜像构建文件
│   └── cache/               # 构建缓存目录（Node.js、JDT LSP、gopls）
├── docs/
│   ├── .vitepress/          # VitePress 配置
│   ├── zh/                  # 中文文档（主维护）
│   │   ├── guide/           # 安装、快速开始、基础用法
│   │   ├── configuration/   # 环境变量、配置文件、示例
│   │   ├── reference/       # CLI 选项、智能体、容器模式
│   │   ├── advanced/        # Docker-in-Docker、会话管理
│   │   └── troubleshooting/ # 构建错误、运行时错误
│   └── en/                  # 英文文档（翻译）
├── test/
│   └── manyoyo.test.js      # Jest 测试文件
├── assets/                  # 资源文件（Logo、截图等）
├── coverage/                # 测试覆盖率报告（git ignored）
├── config.example.json      # 配置文件模板
├── package.json             # 项目依赖与脚本
├── CLAUDE.md                # Claude Code 开发指引（本文件）
├── AGENTS.md                # AI 助手协作规范
└── README.md                # 项目说明文档
```

**关键目录说明：**
- `bin/manyoyo.js`：改动尽量就近、可读，避免跨区重排
- `docker/cache/`：首次构建时自动下载依赖，缓存有效期 2 天
- `docs/zh/` 与 `docs/en/`：结构需保持一致，同步更新
- `test/`：所有测试文件使用 `*.test.js` 命名

## 开发命令

### 测试
```bash
npm test              # 运行所有测试（含覆盖率）
npm run test:unit     # 仅运行单元测试
npm run lint          # 代码检查（当前为空实现）
```

### 文档
```bash
npm run docs:dev      # 启动 VitePress 开发服务器（localhost:5173）
npm run docs:build    # 构建文档站点
npm run docs:preview  # 预览构建后的文档（localhost:4173）
```

### 安装
```bash
npm install -g .      # 全局安装（开发用）
npm link              # 或创建符号链接
npm run install-link  # 或使用快捷脚本
```

## 编码风格与命名约定

**语言与版本：**
- Node.js >= 22.0.0
- 使用 CommonJS 模块系统（`require` / `module.exports`）
- 不使用 ES 模块（`import` / `export`）

**代码格式：**
- 四空格缩进（不使用 Tab）
- 语句结尾使用分号
- 命名清晰简短，避免过长的变量名
- 测试文件遵循 `*.test.js` 命名约定

**组织原则：**
- 选项与默认值集中在 `bin/manyoyo.js` 文件顶部
- 新增功能靠近相关分区，保持代码分区清晰
- 优先小步改动，避免无关重构
- 保持改动范围小、可读性高

**示例代码风格：**
```javascript
// 使用 CommonJS
const fs = require('fs');
const path = require('path');

// 四空格缩进，分号结尾
function validateName(fieldName, value, pattern) {
    if (!pattern.test(value)) {
        console.log(`${RED}错误: ${fieldName} 格式无效${NC}`);
        process.exit(1);
    }
}

// 导出模块
module.exports = { validateName };
```

## 核心架构

### 单文件 CLI 设计

整个 CLI 逻辑位于 `bin/manyoyo.js`（约 1300 行），按功能分区：

#### 1. **配置管理区域**（SECTION: Configuration Management）
   - **三层配置系统：**
     - 全局配置：`~/.manyoyo/manyoyo.json`
     - 运行配置：`~/.manyoyo/run/<name>.json`
     - 命令行参数（最高优先级）
   - **配置合并策略：**
     - 覆盖模式（标量值）：`containerName`、`imageName`、`yolo`、`containerMode`
     - 合并模式（数组）：`env`、`envFile`、`volumes`、`imageBuildArgs`
   - **核心函数：**
     - `loadConfig()`：加载全局配置文件
     - `loadRunConfig(name)`：加载运行配置文件
     - 配置架构定义在 `Config` JSDoc typedef 中

#### 2. **UI 功能区域**（SECTION: UI Functions）
   - **用户交互函数：**
     - `getHelloTip()`：显示容器使用提示
     - `setQuiet()`：设置静默输出模式
     - `askQuestion()`：交互式提问
   - **输入验证：**
     - `validateName()`：验证容器/镜像名称格式

#### 3. **环境变量与挂载卷处理**（SECTION: Environment Variables and Volume Handling）
   - **环境变量处理：**
     - `addEnv()`：验证并添加环境变量，安全检查（无控制字符、无 shell 元字符）
     - `addEnvFile()`：解析 `.env` 文件（支持 `export KEY=VALUE` 语法），去除引号，过滤恶意模式
   - **路径解析规则：**
     - 纯名称 → `~/.manyoyo/env/<name>.env`
     - 路径 → 原样使用
   - **挂载卷管理：**
     - `addVolume()`：添加挂载卷参数

#### 4. **YOLO 模式与容器模式配置**（SECTION: YOLO Mode and Container Mode Configuration）
   - **YOLO 模式映射**（`setYolo()` 函数）：
     - `c`/`cc`/`claude` → `IS_SANDBOX=1 claude --dangerously-skip-permissions`
     - `gm`/`g`/`gemini` → `gemini --yolo`
     - `cx`/`codex` → `codex --dangerously-bypass-approvals-and-sandbox`
     - `oc`/`opencode` → `OPENCODE_PERMISSION='{"*":"allow"}' opencode`
   - **容器嵌套模式**（`setContMode()` 函数）：
     - `common`（默认）：标准容器，无嵌套
     - `dind`（Docker-in-Docker）：`--privileged`，需在容器内手动启动 `dockerd`
     - `sock`（Socket 挂载）：`--privileged + -v /var/run/docker.sock`，危险但可访问宿主机 Docker

#### 5. **Docker 操作区域**（SECTION: Docker Operations）
   - **容器运行时检测：**
     - `ensureDocker()`：自动检测 Docker/Podman
   - **容器操作：**
     - `containerExists()`：检查容器是否存在
     - `getContainerStatus()`：获取容器状态
     - `removeContainer()`：删除容器
   - **工具函数：**
     - `runCmd()`：安全执行命令（参数数组）
     - `dockerExecArgs()`：执行 Docker 命令

#### 6. **镜像构建系统**（SECTION: Image Build System）
   - **缓存管理**（`prepareBuildCache()` 函数）：
     - 下载 Node.js（v24）、JDT LSP、gopls
     - 缓存有效期：2 天（可通过配置修改）
     - Node.js tarball 的 SHA256 校验
     - 多源回退：用户配置 → 腾讯云镜像 → 官方源
   - **镜像构建**（`buildImage()` 函数）：
     - 使用 `--no-cache --load --progress=plain` 构建多阶段 Dockerfile
     - 支持构建参数（`TOOL`、`APT_MIRROR` 等）
   - **辅助函数：**
     - `addImageBuildArg()`：添加构建参数
     - `pruneDanglingImages()`：清理悬空镜像

#### 7. **命令行界面**（SECTION: Command Line Interface）
   - **CLI 解析**（`setupCommander()` 函数）：
     - 使用 Commander.js 解析命令行参数
     - 定义所有 CLI 选项和默认值
     - 合并全局配置、运行配置和命令行参数
   - **配置显示：**
     - `--show-config`：显示最终配置（敏感数据已脱敏）
     - `--show-command`：显示 Docker 命令但不执行

#### 8. **容器生命周期管理**（SECTION: Container Lifecycle Management）
   - **容器创建**（`createNewContainer()` 函数）：
     - 执行 `docker run -d`
     - 使用 `tail -f /dev/null` 作为入口点
     - 将默认命令存储在容器标签中
   - **容器连接**（`connectExistingContainer()` 函数）：
     - 从 `manyoyo.default_cmd` 标签获取默认命令
     - 支持命令覆盖
   - **容器就绪等待**（`waitForContainerReady()` 函数）：
     - 指数退避策略：100ms → 2000ms
     - 最多 30 次重试
   - **容器执行与退出处理：**
     - `executeInContainer()`：在容器中执行命令
     - `handlePostExit()`：交互式提示，用于容器清理或重新进入
   - **命令构建：**
     - `buildDockerRunArgs()`：构建 `docker run` 参数数组
     - `buildDockerRunCmd()`：构建完整命令字符串（用于显示）

#### 9. **主程序入口**
   - **主函数**（`main()` 函数）：
     - 协调所有模块
     - 处理容器创建/连接流程
     - 错误处理和退出逻辑

### Dockerfile 结构

**位置：** `docker/manyoyo.Dockerfile`

**多阶段构建：**
1. **Stage 1（cache-stage）：** 检测 `docker/cache/` 中缓存的 Node.js/JDT LSP/gopls，缺失则下载
2. **Stage 2（final）：** 根据 `TOOL` 参数安装系统包（`full`、`common`、`go`、`java`、`codex`、`gemini` 等）

**关键构建参数：**
- `TOOL`：控制安装哪些 AI 智能体/工具（默认：`full`）
- `APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`：镜像源，加速构建

**预装智能体（完整版）：**
- Claude Code（`claude`）、Gemini（`gemini`）、Codex（`codex`）、OpenCode（`opencode`）
- LSP 服务器：`gopls`、JDT LSP（Java）
- 容器运行时：Podman、Docker

### 配置文件

**全局配置：** `~/.manyoyo/manyoyo.json`（JSON5 格式，支持注释）
- 示例位于 `config.example.json`
- 架构通过 `loadConfig()` 函数中的 JSDoc 定义

**运行配置：** `~/.manyoyo/run/<name>.json`
- 通过 `manyoyo -r <name>` 加载
- 与全局配置相同的架构
- 用于保存预设配置（如 `claude.json`、`gemini.json`）

**环境文件：** `~/.manyoyo/env/<name>.env`
- Bash 风格导出语法：`export KEY="value"` 或 `KEY=value`
- 安全过滤：阻止 shell 元字符、命令替换、控制字符

### 安全措施

1. **输入验证：**
   - 容器/镜像名称：`^[A-Za-z0-9][A-Za-z0-9_.-]*$`
   - 环境变量键：`^[A-Za-z_][A-Za-z0-9_]*$`
   - 环境变量值：阻止字符 `[\r\n\0;&|`$<>]`

2. **路径安全：**
   - `validateHostPath()`：防止挂载 `/`、`/home`、`$HOME`
   - 使用 `fs.realpathSync()` 在验证前解析符号链接

3. **敏感数据脱敏：**
   - `sanitizeSensitiveData()`：对包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`AUTH`、`CREDENTIAL` 的值进行掩码
   - 显示前 4 位 + 后 4 位，如：`sk-ab****5678`

4. **命令执行：**
   - 使用 `spawnSync()` 配合参数数组（非 shell 字符串）防止注入
   - `buildDockerRunArgs()` 返回字符串数组以安全执行

## 常见开发任务

### 构建镜像

```bash
# 完整镜像（包含所有智能体，推荐用于测试）
manyoyo --ib --iv 1.7.0

# 精简镜像（仅通用工具）
manyoyo --ib --iba TOOL=common

# 自定义镜像（指定工具）
manyoyo --ib --iba TOOL=go,codex,java,gemini

# 查看生成的命令而不实际构建
manyoyo --ib --iv 1.7.0 --yes  # 自动确认，跳过交互提示
```

**缓存行为：**
- 首次运行下载依赖到 `docker/cache/`
- 缓存有效期 2 天（可通过 `~/.manyoyo/manyoyo.json` 中的 `cacheTTL` 配置）
- 重新构建速度提升约 5 倍

### 测试配置

```bash
# 显示最终合并的配置（敏感数据已脱敏）
manyoyo --show-config

# 显示 Docker run 命令但不执行
manyoyo -n test --show-command

# 测试运行配置加载
manyoyo -r claude --show-config

# 测试环境文件解析
manyoyo --ef anthropic --show-config
```

### 运行测试

**测试框架：** Jest（配置见 `package.json` 的 `jest` 字段）

**主要测试领域：**
- 基础命令（`--help`、`--version`、`--show-config`）
- 敏感数据脱敏
- 配置验证
- 命令解析

**测试规范：**
1. **新增功能测试：**
   - 在 `test/manyoyo.test.js` 中按现有模式添加测试用例
   - 优先测试关键分支与异常路径
   - 覆盖边界条件和错误处理

2. **Bug 修复测试：**
   - 修复 bug 时建议加入回归测试
   - 测试用例注释中注明相关 issue 或 bug 描述
   - 确保修复后的代码不会再次出现相同问题

3. **测试执行：**
   ```bash
   npm test              # 运行全部测试并生成覆盖率
   npm run test:unit     # 仅运行单元测试
   ```

4. **覆盖率：**
   - 测试覆盖率报告输出到 `coverage/` 目录
   - 重点关注新增代码的测试覆盖率
   - 不强制要求 100% 覆盖率，但关键路径必须覆盖

## 文档系统

**框架：** VitePress，支持 i18n

**结构：**
```
docs/
├── .vitepress/config.mts    # VitePress 配置，含 i18n 路由
├── zh/                      # 中文文档（主要）
│   ├── guide/               # 安装、快速开始、基础用法
│   ├── configuration/       # 环境变量、配置文件、示例
│   ├── reference/           # CLI 选项、智能体、容器模式
│   ├── advanced/            # Docker-in-Docker、会话管理
│   └── troubleshooting/     # 构建错误、运行时错误
└── en/                      # 英文文档（翻译）
    └── （相同结构）
```

**重要注意事项：**
- 主要文档位于 `docs/zh/`，英文文档在 `docs/en/`
- 保持文档简洁，避免重复
- 首页卡片应链接到相关章节
- 侧边栏导航按语言统一，不按子目录拆分

**修改文档时：**
1. 进行最小化、针对性的修改
2. 运行 `npm run docs:build` 检查链接是否损坏
3. 验证侧边栏/导航行为
4. 如内容有变化，同时更新 `zh/` 和 `en/`

## 提交与 PR 指引

### 提交风格

**提交消息格式：**
- 使用简短的中文动词短语（如：`修复配置加载问题`、`新增 YOLO 模式支持`）
- 文档相关提交使用 `docs:` 前缀（如：`docs: 更新安装指南`）
- 保持提交消息简洁明了，不超过 50 个字符

**提交示例：**
```bash
git commit -m "修复容器名称验证正则表达式"
git commit -m "docs: 更新配置文件示例"
git commit -m "新增 Gemini 智能体支持"
git commit -m "重构镜像构建缓存逻辑"
```

### Pull Request 要求

**PR 必须包含：**
1. **变更摘要：** 清晰说明改动内容和原因
2. **测试结果：** 运行 `npm test` 的结果截图或输出
3. **文档更新：** 如有新功能或配置变更，需同步更新文档
4. **检查清单：**
   - [ ] 代码遵循项目编码风格
   - [ ] 已运行 `npm test` 且全部通过
   - [ ] 如涉及文档，已运行 `npm run docs:build` 检查
   - [ ] 中英文文档已同步更新（`docs/zh/` 和 `docs/en/`）
   - [ ] 已更新 `config.example.json`（如有新配置项）
   - [ ] 保留兼容跳转页（如有文档结构调整）

**PR 描述模板：**
```markdown
## 变更摘要
简要描述本 PR 的主要改动...

## 改动类型
- [ ] 新功能
- [ ] Bug 修复
- [ ] 文档更新
- [ ] 重构
- [ ] 其他

## 测试结果
\```
npm test 输出结果...
\```

## 相关文档
- 更新了 `docs/zh/guide/installation.md`
- 更新了 `docs/en/guide/installation.md`
```

## 与 AGENTS.md 配合

该文件包含面向 AI 助手的开发者偏好。要点：
- 主要语言：中文
- 偏好简洁、最小化代码更改
- 提供清晰选项而非开放式来回确认
- 除非明确要求，否则不要自动提交
- 提交文档更改前检查 `npm run docs:build`

## 重要提醒

- **无时间估算：** 不要承诺时间线或估计任务耗时
- **最小化更改：** 只修改直接请求的内容，避免重构无关代码
- **配置优先级：** 始终尊重三层配置系统（CLI > 运行配置 > 全局配置）
- **容器模式：** 警告用户 `sock` 模式的安全隐患（可访问宿主机 Docker socket）
- **Node.js 要求：** 引擎需要 Node.js >= 22.0.0
- **容器运行时：** 支持 Podman（推荐）和 Docker
- **国际化：** 添加新文档时，创建中文和英文两个版本

## 版本对齐与兼容性

### CLI 入口别名

- `manyoyo` 和 `my` 指向同一可执行文件（`bin/manyoyo.js`）
- 修改 `bin/manyoyo.js` 时，确保 `package.json` 的 `bin` 字段正确配置
- 两个命令的行为完全一致，`my` 仅为便捷简写

### 版本同步要求

**发布前检查清单：**
1. **版本号一致性：**
   - `package.json` 的 `version` 字段
   - `bin/manyoyo.js` 中的 `IMAGE_VERSION` 常量
   - `bin/manyoyo.js` 中的 `IMAGE_VERSION_BASE` 常量
   - 文档中的示例版本号（`docs/zh/` 和 `docs/en/`）
   - `README.md` 中的示例版本号

2. **必需文件：**
   - `README.md`
   - `LICENSE`
   - `docker/manyoyo.Dockerfile`
   - `config.example.json`
   - `CLAUDE.md`
   - `AGENTS.md`

3. **文档一致性：**
   - `docs/zh/` 和 `docs/en/` 内容同步
   - `README.md` 示例与最新功能保持一致
   - 配置示例与 `config.example.json` 保持一致

4. **构建验证：**
   ```bash
   npm test                    # 测试通过
   npm run docs:build          # 文档构建成功，无 dead links
   npm install -g .            # 本地安装测试
   manyoyo --version           # 版本号正确
   my --version               # 版本号正确
   ```

### 配置文件路径

配置文件的详细说明参见 [核心架构 - 配置文件](#配置文件) 部分。快速参考：
- 全局配置：`~/.manyoyo/manyoyo.json`
- 运行配置：`~/.manyoyo/run/<name>.json`
- 环境文件：`~/.manyoyo/env/<name>.env`

## 常用模式

### 添加新的 YOLO 智能体

1. 更新 `bin/manyoyo.js` 中的 `setYolo()` 函数（位于 `SECTION: YOLO Mode and Container Mode Configuration`）
2. 为短别名添加 case
3. 在 `docs/zh/reference/agents.md` 和 `docs/en/reference/agents.md` 中文档化
4. 更新 README.md 示例

### 添加新的容器模式

1. 更新 `setContMode()` 函数（位于 `SECTION: YOLO Mode and Container Mode Configuration`）
2. 定义 `CONT_MODE_ARGS` 数组（Docker 参数）
3. 如模式是特权的，添加安全警告
4. 在 `docs/reference/container-modes.md` 中文档化

### 添加新的配置选项

1. 添加到配置架构 JSDoc 注释（位于 `SECTION: Configuration Management`）
2. 如需要，更新 `loadConfig()` / `loadRunConfig()`
3. 在 `setupCommander()` 中添加 CLI 选项（位于 `SECTION: Command Line Interface`）
4. 在配置合并逻辑中处理
5. 更新 `config.example.json`
6. 在 `docs/configuration/` 目录中文档化

## 代码定位快速参考

> **详细架构说明**：参见 [核心架构 - 单文件 CLI 设计](#单文件-cli-设计) 部分。

### 查找代码技巧

当需要定位具体代码时：
1. 使用 `Grep` 工具搜索函数名（如：`function loadConfig`）
2. 查找 `// SECTION:` 标记定位功能区域
3. 使用 `LSP` 工具跳转到定义

### 配置优先级示例

```javascript
// 覆盖模式（标量，最后一个生效）
IMAGE_NAME = options.imageName || runConfig.imageName || config.imageName || IMAGE_NAME;

// 合并模式（数组，全部累加）
const envList = [...(config.env || []), ...(runConfig.env || []), ...(options.env || [])];
```

### 安全验证示例

```javascript
// 名称验证
validateName('containerName', CONTAINER_NAME, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
validateName('imageName', IMAGE_NAME, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
validateName('imageVersion', IMAGE_VERSION, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

// 路径验证
const realHostPath = fs.realpathSync(HOST_PATH);
if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
    console.log(`${RED}⚠️  错误: 不允许挂载根目录或home目录。${NC}`);
    process.exit(1);
}
```

## 变更执行检查清单

在提交代码或创建 PR 之前，请按此清单逐项检查：

### 1. 代码改动检查

- [ ] **最小化改动**：仅修改必要的代码，避免无关重构
- [ ] **代码风格**：遵循四空格缩进、分号结尾、CommonJS 风格
- [ ] **命名规范**：变量和函数命名清晰简短
- [ ] **注释适当**：复杂逻辑添加必要注释（中文）
- [ ] **无调试代码**：移除 `console.log()` 等调试输出（除非有意保留）

### 2. 测试与验证

- [ ] **运行测试**：`npm test` 全部通过
- [ ] **测试覆盖**：新增功能有对应测试用例
- [ ] **回归测试**：Bug 修复添加了回归测试
- [ ] **手动验证**：实际运行 CLI 验证功能正常

### 3. 文档更新

- [ ] **文档构建**：运行 `npm run docs:build` 无错误
- [ ] **链接检查**：检查 dead links 和 404 页面
- [ ] **侧边栏导航**：验证导航结构正确
- [ ] **中英文同步**：`docs/zh/` 和 `docs/en/` 内容一致
- [ ] **README 更新**：如有新功能，更新 `README.md` 示例
- [ ] **配置示例**：更新 `config.example.json`（如有新配置项）

### 4. 安全检查

- [ ] **输入验证**：新增的用户输入都有严格验证
- [ ] **路径安全**：文件路径验证，防止目录遍历
- [ ] **命令注入**：使用参数数组而非字符串执行命令
- [ ] **敏感数据**：确保敏感信息已脱敏处理
- [ ] **权限模式**：特权容器模式有明确的安全警告

### 5. 兼容性检查

- [ ] **版本号同步**：`package.json`、`IMAGE_VERSION`、文档示例保持一致
- [ ] **Node.js 版本**：确保代码兼容 Node.js >= 22
- [ ] **容器运行时**：Podman 和 Docker 都能正常工作
- [ ] **CLI 入口**：`manyoyo` 和 `my` 行为一致

### 6. 提交前最后检查

- [ ] **提交消息**：使用简短中文动词短语，文档用 `docs:` 前缀
- [ ] **分支整理**：移除无关的提交或进行 squash
- [ ] **PR 描述**：填写完整的 PR 模板（变更摘要、测试结果、文档更新）
- [ ] **反馈简洁**：确保提交信息和 PR 描述清晰简洁

### 快速检查命令

```bash
# 完整检查流程
npm test                           # 测试通过
npm run docs:build                 # 文档构建成功
npm install -g .                   # 本地安装
manyoyo --version                  # 验证版本号
manyoyo --show-config              # 验证配置加载
manyoyo -n test --show-command     # 验证命令生成
```

**提示：** 如在检查过程中发现问题，修复后重新运行完整检查流程。
