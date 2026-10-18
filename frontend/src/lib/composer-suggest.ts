// 输入框补全：开头打 “/” 列出可用的斜杠命令；打 “@” 列出工作目录里的文件。
// 只看光标前面的内容，替换时保留光标后面的文字

export type SuggestTrigger =
  | { kind: "slash"; query: string; start: number; end: number }
  | { kind: "mention"; dir: string; prefix: string; start: number; end: number }

export function parseSuggestTrigger(text: string, caret: number): SuggestTrigger | null {
  const before = text.slice(0, caret)
  const slash = before.match(/^\/([A-Za-z0-9:_.-]*)$/)
  if (slash) return { kind: "slash", query: slash[1], start: 0, end: caret }
  const mention = before.match(/(^|\s)@([^\s@]*)$/)
  if (!mention) return null
  const token = mention[2]
  const start = caret - token.length - 1
  const slashAt = token.lastIndexOf("/")
  return {
    kind: "mention",
    dir: slashAt >= 0 ? token.slice(0, slashAt + 1) : "",
    prefix: slashAt >= 0 ? token.slice(slashAt + 1) : token,
    start,
    end: caret,
  }
}

export function applySuggestion(text: string, trigger: SuggestTrigger, insert: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end)
  return { text: next, caret: trigger.start + insert.length }
}
