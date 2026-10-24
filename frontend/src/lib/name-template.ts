// 与服务端 lib/name-template.js 同一套规则：{now}（也认 ${now}）→ 年月日-时分秒，{quickChatPath} → 快捷对话目录
export const DEFAULT_CONTAINER_NAME_TEMPLATE = "my-easy-{now}"
export const DEFAULT_PATH_TEMPLATE = "{quickChatPath}/{now}"

export function formatNow(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

// templated：原文里确实有占位符（按模板生成的目录才由我们在点“创建”时替用户建）
export function expandTemplate(value: string, vars: { now: string; quickChatPath: string }): { value: string; templated: boolean } {
  let templated = false
  let result = value.replace(/\{now\}|\$\{now\}/g, () => {
    templated = true
    return vars.now
  })
  result = result.replace(/\{quickChatPath\}/g, () => {
    templated = true
    return vars.quickChatPath.replace(/\/+$/, "")
  })
  return { value: result, templated }
}
