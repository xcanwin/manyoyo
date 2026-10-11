import { applyTextReplacements, findValueRangeByPath } from "./json5-path-edit"

// 快捷对话设置由它自己的接口直接写进配置文件，而系统设置对话框里的“保存”会把打开时读到的整份文本写回去，
// 不并入的话会把刚改的 run / 工作目录用旧值覆盖回去。这里把服务端文本里这两个值并入本地（可能含未保存修改的）文本。
// 任一边找不到这两个键就返回 null，由调用方重新加载。
export function syncQuickChatIntoRaw(localRaw: string, serverRaw: string): string | null {
  const replacements = []
  for (const key of ["path", "run"]) {
    const keyPath = ["serve", "quickChat", key]
    const server = findValueRangeByPath(serverRaw, keyPath)
    const local = findValueRangeByPath(localRaw, keyPath)
    if (!server || !local) return null
    replacements.push({ start: local.start, end: local.end, text: serverRaw.slice(server.start, server.end) })
  }
  return applyTextReplacements(localRaw, replacements)
}
