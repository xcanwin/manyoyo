import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { EffortMenu } from "@/components/effort-menu"
import { ContextMeter } from "@/components/context-meter"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", agentProgram: "claude", model: "", effort: "" } as SessionSummary
let container: HTMLDivElement
let root: Root
let levels: string[]
let envDefault: string

beforeEach(() => {
  window.localStorage.clear()
  levels = ["low", "high", "max"]
  envDefault = ""
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ levels, effort: "", envDefault }))))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<React.ComponentProps<typeof EffortMenu>> = {}) {
  await act(async () => root.render(<EffortMenu session={session} disabled={false} onChanged={() => {}} {...props} />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="选择推理强度"]')

describe("EffortMenu", () => {
  test("当前模型有强度选项才显示按钮；没有（或不知道）就不显示", async () => {
    await render()
    expect(trigger()).not.toBeNull()
    levels = []
    await render({ session: { ...session, name: "other" } as SessionSummary })
    expect(trigger()).toBeNull()
  })
  test("默认项在环境变量里设了强度时写明", async () => {
    envDefault = "max"
    await render()
    expect(trigger()?.getAttribute("aria-label")).toContain("默认（环境变量：max）")
  })
  test("当前强度不在选项里时显示默认", async () => {
    await render({ session: { ...session, effort: "ultra" } as SessionSummary })
    expect(trigger()?.getAttribute("aria-label")).toContain("当前：默认")
  })
  test("有缓存时按钮立刻出现，不等服务端（服务端结果回来后再对账）", async () => {
    window.localStorage.setItem("manyoyo:effort-levels", JSON.stringify({ "demo\u0000": { levels: ["low", "high"], envDefault: "" } }))
    let release: () => void = () => {}
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ levels: [], envDefault: "" }))) })))
    await act(async () => root.render(<EffortMenu session={session} disabled={false} onChanged={() => {}} />))
    expect(trigger()).not.toBeNull()
    await act(async () => { release() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(trigger()).toBeNull()
  })
  test("第一次没有缓存：服务端回来后显示，并记进缓存", async () => {
    await render()
    expect(trigger()).not.toBeNull()
    expect(JSON.parse(window.localStorage.getItem("manyoyo:effort-levels") ?? "{}")["demo\u0000"].levels).toEqual(["low", "high", "max"])
  })
  test("codex / claude 以外的 Agent 不请求", async () => {
    await render({ session: { ...session, agentProgram: "gemini" } as SessionSummary })
    expect(trigger()).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe("ContextMeter", () => {
  test("手机上只显示图标（读数在浮层里），按钮是 40px 档", async () => {
    await act(async () =>
      root.render(
        <ContextMeter compact size="icon-xl" usage={{ usedTokens: 4500, window: 1_000_000, inputTokens: 46, cacheReadTokens: 4416, cacheCreationTokens: 0, updatedAt: null }} />
      )
    )
    expect(container.textContent).toBe("")
    const button = container.querySelector("button")!
    expect(button.getAttribute("aria-label")).toContain("4.5k · <1%")
    expect(button.className).toContain("size-10")
  })
  test("没数据不显示；有数据显示读数", async () => {
    await act(async () => root.render(<ContextMeter usage={null} />))
    expect(container.textContent).toBe("")
    await act(async () =>
      root.render(
        <ContextMeter usage={{ usedTokens: 4500, window: 1_000_000, inputTokens: 46, cacheReadTokens: 4416, cacheCreationTokens: 0, updatedAt: null }} />
      )
    )
    expect(container.textContent).toBe("4.5k · <1%")
  })
})
