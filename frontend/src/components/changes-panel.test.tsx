import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { diffLineClass } from "@/lib/diff-lines"
import { ChangesPanel } from "./changes-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", containerName: "demo", agentId: "default", status: "running" } as SessionSummary
let container: HTMLDivElement
let root: Root
let calls: string[]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url))
      calls.push(u)
      if (u.includes("/git/changes")) {
        return new Response(JSON.stringify({ repo: true, root: "/w/repo", truncated: false, files: [
          { path: "a.txt", status: "modified", added: 2, deleted: 1 },
          { path: "new.txt", status: "untracked", added: null, deleted: null },
        ] }))
      }
      if (u.includes("/git/rounds/changes")) return new Response(JSON.stringify({ ok: true, truncated: false, files: [{ path: "round.txt", status: "added", added: 3, deleted: 0 }] }))
      if (u.includes("/git/rounds/diff")) return new Response(JSON.stringify({ ok: true, diff: "+from round", truncated: false }))
      if (u.includes("/git/diff")) return new Response(JSON.stringify({ repo: true, diff: "-old\n+<b>new</b>", truncated: false }))
      return new Response("{}")
    })
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const tick = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const rowButton = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLElement

describe("改动视图", () => {
  test("打开时请求一次改动列表；点已跟踪文件看 diff（按纯文本显示）；点未跟踪文件交给文件面板", async () => {
    const onOpenFile = vi.fn()
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={onOpenFile} />))
    await tick()
    expect(calls.filter((u) => u.includes("/git/changes"))).toHaveLength(1)
    expect(container.textContent).toContain("+2")
    await act(async () => rowButton("a.txt").click())
    await tick()
    expect(calls.some((u) => u.includes("/git/diff?path=a.txt"))).toBe(true)
    expect(container.querySelector("b")).toBeNull()
    expect(container.textContent).toContain("+<b>new</b>")
    await act(async () => rowButton("new.txt").click())
    expect(onOpenFile).toHaveBeenCalledWith("/w/repo/new.txt")
    expect(calls.some((u) => u.includes("path=new.txt"))).toBe(false)
  })

  test("diff 行着色", () => {
    expect(diffLineClass("+a")).toContain("success")
    expect(diffLineClass("-a")).toContain("destructive")
    expect(diffLineClass("+++ b/a")).toBe("text-muted-foreground")
    expect(diffLineClass(" a")).toBe("")
  })

  test("按轮看改动：有轮次时可切换，默认最新一轮，diff 走按轮接口", async () => {
    const rounds = [
      { id: "u1", before: "a".repeat(40), after: "b".repeat(40), label: "第 1 轮 · 建文件" },
      { id: "u2", before: "c".repeat(40), after: "d".repeat(40), label: "第 2 轮 · 改文件" },
    ]
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={vi.fn()} rounds={rounds} />))
    await tick()
    await act(async () => rowButton("按轮").click())
    await tick()
    expect(calls.some((u) => u.includes(`/git/rounds/changes?from=${"c".repeat(40)}&to=${"d".repeat(40)}`))).toBe(true)
    expect(container.textContent).toContain("round.txt")
    expect(container.textContent).toContain("第 2 轮 · 改文件")
    await act(async () => rowButton("round.txt").click())
    await tick()
    expect(calls.some((u) => u.includes("/git/rounds/diff?") && u.includes("path=round.txt"))).toBe(true)
    expect(container.textContent).toContain("+from round")
  })

  test("工作目录不是 git 仓库且有轮次：自动改成按轮看", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url)
      calls.push(u)
      if (u.includes("/git/rounds/changes")) return new Response(JSON.stringify({ ok: true, truncated: false, files: [{ path: "x.txt", status: "added", added: 1, deleted: 0 }] }))
      return new Response(JSON.stringify({ repo: false, root: "", files: [], truncated: false }))
    }))
    const rounds = [{ id: "u1", before: "a".repeat(40), after: "b".repeat(40), label: "第 1 轮 · 建文件" }]
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={vi.fn()} rounds={rounds} />))
    await tick()
    await tick()
    expect(container.textContent).toContain("x.txt")
    expect(container.textContent).not.toContain("工作目录不是 git 仓库")
  })

  test("没有轮次：不显示切换按钮（和以前一样）", async () => {
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={vi.fn()} />))
    await tick()
    expect(container.textContent).not.toContain("按轮")
  })

  test("审查改动按钮：可用时点击触发；有任务或排队时禁用并写明原因；不传就没有按钮", async () => {
    const onReview = vi.fn()
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={() => {}} onReview={onReview} />))
    await tick()
    const button = rowButton("审查改动") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(onReview).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={() => {}} onReview={onReview} reviewBlockedReason="任务进行中，等它结束再审查" />))
    await tick()
    const blocked = rowButton("审查改动") as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(blocked.title).toBe("任务进行中，等它结束再审查")
    await act(async () => root.render(<ChangesPanel session={session} onOpenFile={() => {}} />))
    await tick()
    expect(rowButton("审查改动")).toBeUndefined()
  })
})
