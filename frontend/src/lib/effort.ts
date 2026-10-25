// 推理强度的显示名：已知档位写中文，其余原样（codex 的档位因模型而异）
const LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
}

export function effortLabel(level: string): string {
  return LABELS[level] ?? level
}
