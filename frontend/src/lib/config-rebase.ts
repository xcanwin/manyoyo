import { applyTextReplacements, findValueRangeByPath, upsertTopLevelValue } from "./json5-path-edit"

export type LeafEdit = { path: string[]; valueText: string }

// 把“自己改过的字段”重放到最新的配置文本上：
// - 同一路径改过多次以最后一次为准；
// - 最新内容里已经没有这个字段 → 记入 missing（这条修改无法重放）；
// - 与打开时的文本（baseRaw）相比，别人也改了同一个字段 → 以自己的为准，记入 overridden 供提示。
// 只替换字段的值，其余文本（别人的修改、注释、尾逗号）原样保留。
export function rebaseLeafEdits(
  freshRaw: string,
  edits: LeafEdit[],
  baseRaw?: string
): { raw: string; missing: string[]; overridden: string[] } {
  const latest = new Map<string, LeafEdit>()
  for (const edit of edits) {
    latest.delete(edit.path.join("\u0000"))
    latest.set(edit.path.join("\u0000"), edit)
  }
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const missing: string[] = []
  const overridden: string[] = []
  const added: LeafEdit[] = []
  for (const edit of latest.values()) {
    const label = edit.path.join(".")
    const range = findValueRangeByPath(freshRaw, edit.path)
    if (!range) {
      // 打开时配置里就没有、是自己新填的顶层字段（基础分类里）：补上；
      // 原来有、被别人删掉的，以及更深的路径，没法安全补，记为没保存
      const existedAtOpen = baseRaw !== undefined && findValueRangeByPath(baseRaw, edit.path) !== null
      if (edit.path.length === 1 && baseRaw !== undefined && !existedAtOpen) {
        if (edit.valueText !== '""') added.push(edit)
      } else {
        missing.push(label)
      }
      continue
    }
    if (baseRaw !== undefined) {
      const baseRange = findValueRangeByPath(baseRaw, edit.path)
      const baseText = baseRange ? baseRaw.slice(baseRange.start, baseRange.end) : undefined
      if (baseText !== freshRaw.slice(range.start, range.end)) overridden.push(label)
    }
    replacements.push({ start: range.start, end: range.end, text: edit.valueText })
  }
  let raw = applyTextReplacements(freshRaw, replacements)
  for (const edit of added) raw = upsertTopLevelValue(raw, edit.path[0], edit.valueText)
  return { raw, missing, overridden }
}
