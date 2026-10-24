import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DataTable, type DataColumn } from "@/components/data-table"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }))

type Row = { id: string; name: string; path: string; note: string }
const rows: Row[] = [
  { id: "a", name: "alpha", path: "/data/alpha", note: "n1" },
  { id: "b", name: "beta", path: "/data/beta", note: "n2" },
]
const columns: DataColumn<Row>[] = [
  { key: "name", header: "名称", render: (r) => r.name, primary: true },
  { key: "path", header: "路径", render: (r) => r.path, mono: true },
  { key: "note", header: "备注", render: (r) => r.note, mobile: "hidden" },
]

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  mobile.value = false
})
const render = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) =>
  act(async () =>
    root.render(<DataTable<Row> label="示例" columns={columns} rows={rows} rowKey={(r) => r.id} {...props} />)
  )

describe("DataTable", () => {
  test("桌面渲染成表格：表头、行、等宽列，操作列在最右", async () => {
    await render({ actions: (r) => <button aria-label={`删除 ${r.name}`}>x</button> })
    const table = container.querySelector("table")!
    expect(table.getAttribute("aria-label")).toBe("示例")
    expect(Array.from(table.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["名称", "路径", "备注", ""])
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(table.querySelector("tbody td:nth-child(2)")!.className).toContain("font-mono")
    expect(container.querySelector('[aria-label="删除 beta"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="data-table-cards"]')).toBeNull()
  })

  test("手机渲染成卡片：primary 列是标题，mobile hidden 的列不出现，行内操作可用", async () => {
    mobile.value = true
    const onDelete = vi.fn()
    await render({ actions: (r) => <button aria-label={`删除 ${r.name}`} onClick={() => onDelete(r.id)}>x</button> })
    expect(container.querySelector("table")).toBeNull()
    const cards = container.querySelectorAll('[role="listitem"]')
    expect(cards).toHaveLength(2)
    expect(cards[0].querySelector('[data-slot="card-title"]')!.textContent).toBe("alpha")
    expect(cards[0].textContent).toContain("/data/alpha")
    expect(cards[0].textContent).not.toContain("n1")
    expect(cards[0].textContent).not.toContain("备注")
    await act(async () => (container.querySelector('[aria-label="删除 beta"]') as HTMLElement).click())
    expect(onDelete).toHaveBeenCalledWith("b")
  })

  test("可点的行：点击和键盘（Enter）都触发，行内操作的点击不冒泡成点行", async () => {
    const onRowClick = vi.fn()
    const onAction = vi.fn()
    await render({ onRowClick, actions: () => <button aria-label="操作" onClick={onAction}>x</button> })
    const row = container.querySelector("tbody tr") as HTMLElement
    expect(row.tabIndex).toBe(0)
    await act(async () => row.click())
    await act(async () => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    expect(onRowClick).toHaveBeenCalledTimes(2)
    await act(async () => (container.querySelector('[aria-label="操作"]') as HTMLElement).click())
    expect(onAction).toHaveBeenCalled()
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  test("空状态给说明和主操作；加载中显示骨架，不显示表格", async () => {
    await render({ rows: [], empty: { title: "还没有数据", description: "先添加一个", action: <button>添加</button> } })
    expect(container.querySelector('[data-slot="data-table-empty"]')!.textContent).toContain("还没有数据")
    expect(container.textContent).toContain("添加")
    expect(container.querySelector("table")).toBeNull()
    await render({ loading: true })
    expect(container.querySelector('[data-slot="data-table-loading"]')!.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
    expect(container.querySelector("table")).toBeNull()
  })
})
