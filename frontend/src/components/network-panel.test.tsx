import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { NetworkPanel } from "./network-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", containerName: "demo", agentId: "default", status: "running" } as SessionSummary
let container: HTMLDivElement
let root: Root
let calls: { url: string; method: string; body: unknown }[]
let coverage: { proxied: boolean; auditHttp: boolean; reason: string }
let policy: Record<string, unknown>

beforeEach(() => {
  calls = []
  coverage = { proxied: false, auditHttp: false, reason: "noDomainRules" }
  policy = { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false, auditHttp: false }
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = decodeURIComponent(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url: u, method: init?.method || "GET", body })
      if (u.includes("/network/traffic") && (init?.method || "GET") === "DELETE") return new Response(JSON.stringify({ cleared: true }))
      if (u.includes("/network/traffic")) {
        return new Response(JSON.stringify({
          records: [
            { id: "traffic-0", ts: "2026-01-01T00:00:02.000Z", host: "cdn.example.com", port: 80, decision: "allow", proto: "http", method: "GET", status: 200, bytesIn: 10, bytesOut: 2048, durationMs: 12 },
            { id: "denied-api.example.com-443", ts: "2026-01-01T00:00:01.000Z", host: "api.example.com", port: 443, decision: "deny", proto: "tcp", method: "", status: 0, bytesIn: 0, bytesOut: 0, durationMs: 0, count: 3 },
          ],
          summary: { allowed: 1, denied: 3, hosts: 2, bytesIn: 10, bytesOut: 2048 },
          coverage,
        }))
      }
      if (u.endsWith("/network") && (init?.method || "GET") === "GET") return new Response(JSON.stringify({ policy }))
      if (u.endsWith("/network/allow")) return new Response(JSON.stringify({ ok: true }))
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

describe("网络视图", () => {
  test("汇总、覆盖提示、允许与拒绝记录、不显示 path / 正文", async () => {
    await act(async () => root.render(<NetworkPanel session={session} onManageRules={() => {}} />))
    await tick()
    expect(container.textContent).toContain("cdn.example.com")
    expect(container.textContent).toContain("api.example.com")
    expect(container.textContent).toContain("3 次")
    expect(container.textContent).toContain("没有域名规则")
    expect(container.textContent).toContain("记录 HTTP(S)")
    expect(container.textContent).toContain("只记录 host、端口、方法、状态、字节、耗时")
    expect(container.textContent).toContain("2.0 KB")
    expect(container.textContent).not.toContain("/v1/chat")
  })

  test("打开记录开关：PUT 完整策略并带 auditHttp；拒绝行一键允许；清空要确认", async () => {
    await act(async () => root.render(<NetworkPanel session={session} onManageRules={() => {}} />))
    await tick()
    const toggle = container.querySelector('[role="switch"]') as HTMLElement
    await act(async () => toggle.click())
    await tick()
    const put = calls.find((call) => call.url.endsWith("/network") && call.method === "PUT")
    expect(put?.body).toEqual({ policy: expect.objectContaining({ auditHttp: true, preset: "restricted" }) })
    expect(policy.auditHttp).toBe(false)

    const allowButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === "允许")
    await act(async () => allowButtons[allowButtons.length - 1].click())
    await tick()
    expect(calls.find((call) => call.url.endsWith("/network/allow"))?.body).toEqual({ domain: "api.example.com", confirmRisk: true })

    const clear = container.querySelector<HTMLButtonElement>('[aria-label="清空"]')!
    await act(async () => clear.click())
    await tick()
    const confirms = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent === "清空")
    await act(async () => confirms[confirms.length - 1].click())
    await tick()
    expect(calls.some((call) => call.url.includes("/network/traffic") && call.method === "DELETE")).toBe(true)
  })

  test("没有记录时显示空状态；管理规则交给父组件", async () => {
    const onManageRules = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        records: [],
        summary: { allowed: 0, denied: 0, hosts: 0, bytesIn: 0, bytesOut: 0 },
        coverage: { proxied: true, auditHttp: true, reason: "proxied" },
      })))
    )
    await act(async () => root.render(<NetworkPanel session={session} onManageRules={onManageRules} />))
    await tick()
    expect(container.textContent).toContain("还没有网络记录")
    await act(async () => button("管理规则")!.click())
    expect(onManageRules).toHaveBeenCalled()
  })
})
