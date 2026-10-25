import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { StoragePanel } from "@/components/storage-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deletedHistories = [{ name: "gone-1", bytes: 2048, updatedAt: "2026-10-01T00:00:00Z", remark: "旧项目" }]
const rows = [
  { path: "/h/work/a", managed: true, status: "history-only", sessions: [{ name: "gone-1", state: "deleted" }], mtimeMs: 1, deletable: true, empty: false },
  { path: "/h/work/b", managed: true, status: "in-use", sessions: [{ name: "live-1", state: "running", remark: "前端联调" }], mtimeMs: 2, deletable: false, empty: false },
  { path: "/h/project", managed: false, status: "history-only", sessions: [], mtimeMs: 3, deletable: false, empty: false },
  { path: "/h/work/e1", managed: true, status: "unused", sessions: [], mtimeMs: 4, deletable: true, empty: true },
  { path: "/h/work/e2", managed: true, status: "unused", sessions: [], mtimeMs: 5, deletable: true, empty: true },
]

describe("StoragePanel", () => {
  let opened: string[]
  let calls: string[]
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
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
    const items = container.querySelectorAll("[data-testid^='storage-row-']")
    expect(items).toHaveLength(5)
    expect(calls.filter((call) => call.includes("/api/storage/size"))).toHaveLength(2)
    expect(items[3].textContent).toContain("空目录")
    expect(items[3].textContent).not.toContain("4.0")
    expect(items[0].textContent).toContain("3.0 MB")
    // 关联容器：名字之外还显示容器备注（有就显示）
    const text = container.textContent ?? ""
    expect(text).toContain("live-1")
    expect(text).toContain("运行中")
    expect(text).toContain("前端联调")
    expect(items[2].textContent).toContain("计算体积")
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label^="删除 /"]')
    expect(Array.from(buttons).map((button) => button.disabled)).toEqual([false, true, true, false, false])
  })

  test("列出已删除容器的历史，并能查看目录内容", async () => {
    const container = await mount()
    expect(container.querySelectorAll("[data-testid^='storage-history-']")).toHaveLength(1)
    expect(container.querySelector("[data-testid^='storage-history-']")!.textContent).toContain("2.0 KB")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="查看 /h/work/a"]')!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(calls).toContain("GET /api/storage/files?path=%2Fh%2Fwork%2Fa&sub=")
    expect(document.body.querySelectorAll("[data-testid^='storage-entry-']")).toHaveLength(2)
  })

  test("“已删容器且删历史的空目录”分类只列空目录，删除空目录按 emptyOnly 逐个删除", async () => {
    const container = await mount()
    const filterButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.startsWith("已删容器且删历史的空目录"))!
    expect(filterButton.textContent).toContain("有2个")
    await act(async () => filterButton.click())
    expect(Array.from(container.querySelectorAll("[data-testid^='storage-row-']")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("/h/work/e1"),
      expect.stringContaining("/h/work/e2"),
    ])
    const clearAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "删除空目录")!
    await act(async () => clearAll.click())
    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "删除空目录")!
    await act(async () => confirmButton.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(calls.filter((call) => call.startsWith("DELETE /api/storage/dirs"))).toHaveLength(2)
  })

  test("当前容器加黑底标签，容器名右边有进入按钮，侧栏里没有的容器不给按钮", async () => {
    const container = await mount()
    const liveRow = container.querySelectorAll("[data-testid^='storage-row-']")[1]
    expect(liveRow.textContent).toContain("当前容器")
    expect(container.querySelectorAll("[data-testid^='storage-row-']")[0].textContent).not.toContain("当前容器")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="进入 live-1"]')!.click())
    expect(opened).toEqual(["live-1"])
    expect(container.querySelector('button[aria-label="进入 not-in-sidebar"]')).toBeNull()
    expect(container.querySelector("[data-testid^='storage-history-']")!.querySelector('button[aria-label="进入 gone-1"]')).not.toBeNull()
  })

  test("关联容器一格：容器已删但留着历史 / 容器和历史都删了（只对 MANYOYO 自己建的目录）/ 别人的目录留空；表头叫“关联容器”和“容器”", async () => {
    const container = await mount()
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent)
    expect(headers).toContain("关联容器")
    expect(headers).toContain("容器")
    expect(headers).not.toContain("会话")
    const cells = container.querySelectorAll("[data-testid^='storage-row-']")[2].querySelectorAll("td")
    expect(cells[2].textContent).toBe("")
    const managedCells = container.querySelectorAll("[data-testid^='storage-row-']")[3].querySelectorAll("td")
    expect(managedCells[2].textContent).toBe("已删容器且删历史")
    expect(container.querySelectorAll("[data-testid^='storage-row-']")[0].textContent).toContain("已删容器且存历史")
  })

  test("版式统一：两块都有小标题，列顺序是 名称 → 占用 → …，图标按钮同一个大小，删除全部历史在小字下面", async () => {
    const container = await mount()
    const headings = Array.from(container.querySelectorAll("h1")).map((h) => h.textContent)
    expect(headings).toEqual(["宿主机工作目录", "已删除容器的对话历史"])
    const tables = container.querySelectorAll("table")
    expect(Array.from(tables[0].querySelectorAll("th")).map((th) => th.textContent)).toEqual(["宿主机目录", "占用", "关联容器", "修改时间", ""])
    expect(Array.from(tables[1].querySelectorAll("th")).map((th) => th.textContent)).toEqual(["容器", "占用", "最后更新", ""])
    const historyRow = container.querySelector("[data-testid^='storage-history-']")!
    expect(historyRow.querySelector('button[aria-label="删除历史 gone-1"]')).not.toBeNull()
    // 容器名右边显示容器备注
    expect(historyRow.textContent).toContain("旧项目")
    // 这里的容器都已删除：同样带“已删容器且存历史”标签
    expect(historyRow.textContent).toContain("已删容器且存历史")
    expect(historyRow.querySelectorAll("td")[0].textContent).toContain("gone-1")
    const sizes = new Set(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="查看 "], button[aria-label^="删除 "], button[aria-label^="进入 "], button[aria-label^="删除历史 "]')).map((button) => button.className.match(/size-\d+/)?.[0] ?? button.className)
    )
    expect(sizes.size).toBe(1)
    const deleteAll = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "删除全部历史")!
    expect(deleteAll.parentElement!.previousElementSibling!.textContent).toContain("容器删掉后")
  })
})
