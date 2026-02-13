# Workflow

## 1) 最小探测（先做，不读取模板/清单）
- 运行：`ls -la`
- 运行：`rg --files -g '!.agents/**' -g '!temp/**' -g '!tmp/**' -g '!.tmp/**' | head -n 200`
- 识别技术栈入口（如 `src/`、`package.json`、`pyproject.toml`、`Makefile`）。

## 2) 条件分支判断
- 若按忽略规则过滤后无有效文件：标记“空目录场景”。
- 判断 Git 环境：`git rev-parse --is-inside-work-tree >/dev/null 2>&1`。
- 仅在 Git 仓库中运行：`git log --oneline -n 30`。
- 非 Git 场景跳过提交风格提取，并在输出中明确证据缺失。

## 3) 模式执行
- 默认模式选择：
  - 若 `AGENTS.md` 存在：默认 `audit-only`。
  - 若 `AGENTS.md` 不存在：默认 `audit-then-apply`。
- `audit-only`：
  - 读取 `AGENTS.md`（若不存在需明确说明）。
  - 用最小命令校验其中的命令、路径、流程是否与仓库事实一致。
  - 按技能规定模板输出“建议尽快改 / 可选补充 / 无需改动”。
- `apply` / `audit-then-apply`：
  - 提取可执行命令：`package.json scripts`、`Makefile` 目标、`tools/` 脚本。
  - 观察现有代码风格与命名模式。
  - 仅在 Git 历史存在时提取提交风格。

## 4) 生成或更新 AGENTS.md（仅 apply / audit-then-apply 模式）
- 仅在本步骤读取：`assets/AGENTS.zh.template.md`。
- 若 `AGENTS.md` 已存在，做原位增量更新，保留有效仓库特定内容。
- 若不存在，基于模板生成并替换所有占位符。

## 5) 写入前自检（仅 apply / audit-then-apply 模式）
- 仅在本步骤读取：`references/quality-checklist.md`。
- 确认无占位符（例如 `{{...}}`）。
- 确认命令真实可执行且路径正确。
- 确认内容简洁且不引入仓库无关规范。
