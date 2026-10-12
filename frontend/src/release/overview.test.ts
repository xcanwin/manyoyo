import { describe, expect, test } from "vitest"

import { buildOverview } from "./overview"

const base = { version: "8.6.2", published: false, pendingCommits: [] as string[] }

describe("buildOverview", () => {
  test("已发布且有新提交：提示有多少改动没发布，主按钮是开始发布新版本，不显示一键发布", () => {
    const view = buildOverview({ ...base, published: true, pendingCommits: ["a", "b"] }, null)
    expect(view.title).toBe("有 2 个改动还没发布")
    expect(view.description).toContain("先升版本号")
    expect(view.primary).toEqual({ kind: "version", label: "开始发布新版本" })
    expect(view.showRunAll).toBe(false)
    expect(view.historyNote).toBe("下面是 v8.6.2 的发布记录")
  })

  test("已发布且没有新提交：没有主按钮，也不显示一键发布", () => {
    const view = buildOverview({ ...base, published: true }, null)
    expect(view.title).toBe("v8.6.2 已发布 ✓")
    expect(view.description).toBe("还没有新的改动。")
    expect(view.primary).toBeNull()
    expect(view.showRunAll).toBe(false)
  })

  test("发布进行中：主按钮是下一步，显示一键发布，没有发布记录提示", () => {
    const view = buildOverview({ ...base, version: "8.7.0" }, { id: "commit", title: "提交", detail: "有未提交的改动" })
    expect(view.title).toBe("下一步：提交")
    expect(view.primary).toEqual({ kind: "stage", label: "执行「提交」" })
    expect(view.showRunAll).toBe(true)
    expect(view.historyNote).toBe("")
  })

  test("已公开但验证 / npm 还没完成：仍然引导下一步，不显示成已发布", () => {
    const view = buildOverview({ ...base, published: true }, { id: "verify", title: "发版后验证", detail: "" })
    expect(view.title).toBe("下一步：发版后验证")
    expect(view.primary).toEqual({ kind: "stage", label: "执行「发版后验证」" })
  })
})
