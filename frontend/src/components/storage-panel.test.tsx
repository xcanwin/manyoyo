import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { StoragePanel } from "@/components/storage-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deletedHistories = [{ name: "gone-1", bytes: 2048, updatedAt: "2026-10-01T00:00:00Z" }]
const rows = [
  { path: "/h/work/a", managed: true, status: "history-only", sessions: [{ name: "gone-1", state: "deleted" }], mtimeMs: 1, deletable: true, empty: false },
  { path: "/h/work/b", managed: true, status: "in-use", sessions: [{ name: "live-1", state: "running" }], mtimeMs: 2, deletable: false, empty: false },
  { path: "/h/project", managed: false, status: "history-only", sessions: [], mtimeMs: 3, deletable: false, empty: false },
  { path: "/h/work/e1", managed: true, status: "unused", sessions: [], mtimeMs: 4, deletable: true, empty: true },
  { path: "/h/work/e2", managed: true, status: "unused", sessions: [], mtimeMs: 5, deletable: true, empty: true },
]

describe("StoragePanel", () => {
  let opened: string[]
  let calls: string[]
  beforeEach(() => {
    calls = []
    opened = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || "GET"} ${url}`)
        const body = url.startsWith("/api/storage/size") ? { bytes: 3 * 1024 * 1024 } : url === "/api/storage" ? { rows, deletedHistories } : url.startsWith("/api/storage/files") ? { entries: [{ name: "sub", type: "dir", size: null, mtimeMs: 1 }, { name: "a.txt", type: "file", size: 5, mtimeMs: 1 }], truncated: false } : { removed: true }
        return new Response(JSON.stringify(body), { status: 200 })
      })
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  async function mount() {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<StoragePanel currentContainer="live-1" openableContainers={["live-1", "gone-1"]} onOpenContainer={(name) => opened.push(name)} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    return container
  }

  test("工作目录自动算体积，用户项目目录要点了才算；在用的目录不能删", async () => {
    const container = await mount()
    const items = container.querySelectorAll("[data-storage-row]")
    expect(items).toHaveLength(5)
    expect(calls.filter((call) => call.includes("/api/storage/size"))).toHaveLength(2)
    expect(items[3].textContent).toContain("空目录")
    expect(items[3].textContent).not.toContain("4.0")
    expect(items[0].textContent).toContain("3.0 MB")
    expect(items[2].textContent).toContain("计算体积")
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="删除"]')
    expect(Array.from(buttons).map((button) => button.disabled)).toEqual([false, true, true, false, false])
  })

  test("列出已删除容器的历史，并能查看目录内容", async () => {
    const container = await mount()
    expect(container.querySelectorAll("[data-storage-history]")).toHaveLength(1)
    expect(container.querySelector("[data-storage-history]")!.textContent).toContain("2.0 KB")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="查看 /h/work/a"]')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(calls).toContain("GET /api/storage/files?path=%2Fh%2Fwork%2Fa&sub=")
    expect(document.body.querySelectorAll("[data-storage-entry]")).toHaveLength(2)
  })

  test("“无关联容器且为空”分类只列空目录，清理空目录按 emptyOnly 逐个删除", async () => {
    const container = await mount()
    const filterButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.startsWith("无关联容器且为空"))!
    expect(filterButton.textContent).toContain("有2个")
    await act(async () => filterButton.click())
    expect(Array.from(container.querySelectorAll("[data-storage-row]")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("/h/work/e1"),
      expect.stringContaining("/h/work/e2"),
    ])
    const clearAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "清理空目录")!
    await act(async () => clearAll.click())
    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "清理空目录")!
    await act(async () => confirmButton.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(calls.filter((call) => call.startsWith("DELETE /api/storage/dirs"))).toHaveLength(2)
  })

  test("当前容器加黑底标签，容器名右边有进入按钮，侧栏里没有的容器不给按钮", async () => {
    const container = await mount()
    const liveRow = container.querySelectorAll("[data-storage-row]")[1]
    expect(liveRow.textContent).toContain("当前容器")
    expect(container.querySelectorAll("[data-storage-row]")[0].textContent).not.toContain("当前容器")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="进入 live-1"]')!.click())
    expect(opened).toEqual(["live-1"])
    expect(container.querySelector('button[aria-label="进入 not-in-sidebar"]')).toBeNull()
    expect(container.querySelector("[data-storage-history]")!.querySelector('button[aria-label="进入 gone-1"]')).not.toBeNull()
  })

  test("没有关联容器的行，关联容器一格是空白；表头叫“关联容器”和“容器”", async () => {
    const container = await mount()
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent)
    expect(headers).toContain("关联容器")
    expect(headers).toContain("容器")
    expect(headers).not.toContain("会话")
    const cells = container.querySelectorAll("[data-storage-row]")[2].querySelectorAll("td")
    expect(cells[1].textContent).toBe("")
  })
})
