# Workflow

## 1) 快速探测仓库事实
- 运行：`ls -la`
- 运行：`rg --files | head -n 200`
- 运行：`git log --oneline -n 30`
- 识别主要技术栈与入口文件（如 `KeepChatGPT.user.js`、`src/`、`package.json`、`pyproject.toml`）。

## 2) 提取可执行命令
- 若存在 `package.json`：读取 `scripts` 作为命令来源。
- 若存在 `Makefile`：提取常用 `make` 目标。
- 若存在 `tools/` 或脚本目录：提取实际可运行命令。
- 若无自动化测试框架：明确写“手工回归测试”。

## 3) 提取代码与提交流程约定
- 从仓库现有代码观察缩进、命名与文件命名模式。
- 从 `git log` 总结提交风格（例如简短中文动词短语、`docs:` 前缀等）。

## 4) 生成 AGENTS.md
- 以 `assets/AGENTS.zh.template.md` 为基础填充。
- 保留模板中的“协作偏好 / TDD / 检查清单”核心要求。
- 补充仓库特有目录、命令、测试方式与 PR 期望。

## 5) 写入前自检
- 无占位符（例如 `{{...}}`）。
- 命令真实可执行且路径正确。
- 内容简洁，不引入与仓库无关规范。
