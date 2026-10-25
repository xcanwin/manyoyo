// 网页自己处理的斜杠命令（不交给 Agent）。发送时输入框内容以 /<注册名> 开头（后面是空白或结尾）、
// 且适用于当前 Agent 才拦截，否则照旧当提示词发出。候选列表里同名时网页命令优先。

export type WebCommand = {
  name: string
  description: string
  argumentHint?: string
  // 适用的 Agent 程序；不写表示全部
  agents?: string[]
}

export const WEB_COMMANDS: WebCommand[] = [
  { name: "model", description: "打开模型菜单" },
  { name: "effort", description: "设置推理强度，不带参数则打开下拉", argumentHint: "[级别]", agents: ["claude", "codex"] },
  { name: "status", description: "打开 Agent 详情" },
  { name: "diff", description: "查看工作目录里的改动" },
  { name: "clear", description: "在这个容器里新建一个 AGENT" },
  { name: "copy", description: "复制最后一条回复" },
  { name: "fork", description: "从最新处分叉出一个新的 AGENT，带着现在的对话" },
  { name: "btw", description: "带着上下文问一句，不打断主任务", argumentHint: "<问题>", agents: ["claude", "codex"] },
  { name: "recap", description: "用一句话回顾刚才做到哪", agents: ["claude", "codex"] },
]

export function listWebCommands(agentProgram: string): WebCommand[] {
  return WEB_COMMANDS.filter((item) => !item.agents || item.agents.includes(agentProgram))
}

export function matchWebCommand(
  text: string,
  agentProgram: string
): { command: WebCommand; args: string } | null {
  const matched = /^\/([A-Za-z0-9:_.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!matched) return null
  const command = listWebCommands(agentProgram).find((item) => item.name === matched[1])
  return command ? { command, args: (matched[2] ?? "").trim() } : null
}

// 最后一条已完成的 Agent 回复（给 /copy 用）
export function lastAgentReply(
  messages: { role: string; mode?: string; pending?: boolean; content: string; streamTrace?: boolean }[]
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "assistant" && message.mode === "agent" && !message.pending && !message.streamTrace && message.content.trim()) {
      return message.content
    }
  }
  return ""
}
