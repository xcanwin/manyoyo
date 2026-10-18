// diff 按行着色；内容来自容器，只当纯文本放进 React 节点，不拼 HTML
export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground"
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-400"
  if (line.startsWith("@@")) return "text-muted-foreground"
  return ""
}
