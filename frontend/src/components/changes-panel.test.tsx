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
    expect(diffLineClass("+a")).toContain("emerald")
    expect(diffLineClass("-a")).toContain("red")
    expect(diffLineClass("+++ b/a")).toBe("text-muted-foreground")
    expect(diffLineClass(" a")).toBe("")
  })
})
