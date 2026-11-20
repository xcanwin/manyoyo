import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import type { Plan } from "@/lib/plan"
import { PlanPanel } from "./plan-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", containerName: "demo", agentId: "default", status: "running" } as SessionSummary
let container: HTMLDivElement
let root: Root
let calls: { url: string; method: string; body: unknown; ifMatch: string | null }[]
let plan: Plan
let putStatus: number

beforeEach(() => {
  calls = []
  putStatus = 200
  plan = {
    version: 1,
    revision: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [
      { id: "todo:1", subject: "写代码", status: "completed", source: "agent", updatedAt: null },
      { id: "todo:2", subject: "写<b>测试</b>", status: "in_progress", source: "agent", updatedAt: null },
      { id: "task:3", subject: "跑测试", status: "pending", source: "agent", updatedAt: null },
    ],
    dod: [{ id: "dod_1", text: "跑通测试", note: "本地", checked: false, checkedAt: null, checkedBy: "user" }],
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = decodeURIComponent(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const method = init?.method || "GET"
      calls.push({ url: u, method, body, ifMatch: new Headers(init?.headers).get("If-Match") })
      if (u.endsWith("/plan") && method === "GET") {
        return new Response(JSON.stringify({ plan, etag: "aaaaaaaaaaaaaaaa" }))
      }
      if (u.endsWith("/plan/dod") && method === "PUT") {
        if (putStatus === 409) return new Response(JSON.stringify({ error: "页面已更新，请刷新页面后再保存", conflict: true, plan, etag: "bbbbbbbbbbbbbbbb" }), { status: 409 })
        const saved: Plan = {
          ...plan,
          revision: plan.revision + 1,
          dod: (body.items as Array<{ id?: string; text: string; checked: boolean }>).map((item, index) => ({
            id: item.id || `dod_new_${index}`,
            text: item.text,
            note: "",
            checked: item.checked,
            checkedAt: item.checked ? "2026-01-02T00:00:00.000Z" : null,
            checkedBy: "user" as const,
          })),
        }
        return new Response(JSON.stringify({ plan: saved, etag: "cccccccccccccccc" }))
      }
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
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const tick = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes(text))

describe("计划视图", () => {
  test("分组显示进度；计划项按纯文本渲染，不执行 HTML", async () => {
    await act(async () => root.render(<PlanPanel session={session} />))
    await tick()
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1)
    expect(container.textContent).toContain("1 / 3")
    expect(container.textContent).toContain("进行中")
    expect(container.textContent).toContain("待办")
    expect(container.textContent).toContain("写<b>测试</b>")
    expect(container.querySelector("b")).toBeNull()
    expect((container.querySelector('input[aria-label="验收标准"]') as HTMLInputElement).value).toBe("跑通测试")
  })

  test("添加 / 勾选 / 删除验收标准后保存：带 If-Match，保存成功后不算未保存", async () => {
    await act(async () => root.render(<PlanPanel session={session} />))
    await tick()
    await act(async () => button("添加一条")!.click())
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[aria-label="验收标准"]'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(inputs[1], "检查 diff")
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }))
    })
    const checks = Array.from(container.querySelectorAll<HTMLElement>('[role="checkbox"]'))
    await act(async () => checks[1].click())
    await act(async () => button("保存验收标准")!.click())
    await tick()
    const put = calls.find((call) => call.method === "PUT")!
    expect(put.ifMatch).toBe("aaaaaaaaaaaaaaaa")
    expect(put.body).toEqual({ items: [
      { id: "dod_1", text: "跑通测试", note: "本地", checked: false },
      { text: "检查 diff", note: "", checked: true },
    ] })
    expect(container.textContent).not.toContain("有未保存的修改")
  })

  test("保存冲突：提示重新加载 / 仍然保存；仍然保存先取最新 etag 再写", async () => {
    putStatus = 409
    await act(async () => root.render(<PlanPanel session={session} />))
    await tick()
    const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]')!
    await act(async () => checkbox.click())
    await act(async () => button("保存验收标准")!.click())
    await tick()
    expect(container.textContent).toContain("计划已在别处更新")
    putStatus = 200
    await act(async () => button("仍然保存")!.click())
    await tick()
    const puts = calls.filter((call) => call.method === "PUT")
    expect(puts).toHaveLength(2)
    expect(puts[1].ifMatch).toBe("aaaaaaaaaaaaaaaa")
    expect(container.textContent).not.toContain("计划已在别处更新")
  })

  test("实时计划到达时重新加载（草稿没改就覆盖）；空状态与未保存提示", async () => {
    await act(async () => root.render(<PlanPanel session={session} />))
    await tick()
    const live = { ...plan, revision: 3, items: [{ id: "todo:9", subject: "新计划", status: "pending" as const, source: "agent" as const, updatedAt: null }] }
    plan = live
    await act(async () => root.render(<PlanPanel session={session} livePlan={live} />))
    await tick()
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2)
    expect(container.textContent).toContain("新计划")

    const emptyLive = { ...plan, revision: 4, items: [], dod: [] }
    plan = emptyLive
    await act(async () => root.render(<PlanPanel session={session} livePlan={emptyLive} />))
    await tick()
    expect(container.textContent).toContain("当前 Agent 还没有提供计划")
    expect(container.textContent).toContain("还没有验收标准")
  })
})
