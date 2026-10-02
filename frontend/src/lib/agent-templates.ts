// 与 lib/agent-resume.js 的 AGENT_PROMPT_TEMPLATE_MAP 保持一致
export const CLI_PROMPT_TEMPLATES: Record<string, string> = {
  claude: "claude -p {prompt}",
  codex: "codex exec --skip-git-repo-check {prompt}",
  gemini: "gemini -p {prompt}",
  opencode: "opencode run {prompt}",
}

// AGENTS.md 里的 YOLO 别名映射：c/cc/claude、gm/g/gemini、cx/codex、oc/opencode
const YOLO_ALIASES: Record<string, string> = {
  c: "claude",
  cc: "claude",
  claude: "claude",
  gm: "gemini",
  g: "gemini",
  gemini: "gemini",
  cx: "codex",
  codex: "codex",
  oc: "opencode",
  opencode: "opencode",
}

export function normalizeYolo(value: string): string {
  const key = value.trim().toLowerCase()
  return YOLO_ALIASES[key] || ""
}
