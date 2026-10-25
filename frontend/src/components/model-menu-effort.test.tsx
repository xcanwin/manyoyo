import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { ModelMenu } from "@/components/model-menu"
import { ContextMeter } from "@/components/context-meter"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", agentProgram: "claude", model: "", effort: "" } as SessionSummary
let container: HTMLDivElement
let root: Root
let levels: string[]
let envDefault: string
let posts: { url: string; body: unknown }[]

beforeEach(() => {
  window.localStorage.clear()
  levels = ["low", "high", "max"]
  envDefault = ""
  posts = []
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return new Response("{}")
      }
      if (String(url).endsWith("/effort")) return new Response(JSON.stringify({ levels, effort: "", envDefault }))
      return new Response(JSON.stringify({ defaultModel: "", options: [], models: [] }))
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

async function render(props: { session?: SessionSummary } = {}) {
  await act(async () => root.render(<ModelMenu session={props.session ?? session} disabled={false} onChanged={() => {}} />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}
async function openMenu() {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"]')!.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}
const items = () => Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((el) => el.textContent ?? "")

describe("推理强度在模型菜单最下面", () => {
  test("有选项时，模型菜单底部有“推理强度”一组；没有按钮在输入框里单独占位", async () => {
    await render()
    expect(container.querySelector('button[aria-label^="选择推理强度"]')).toBeNull()
    await openMenu()
    const text = document.body.textContent ?? ""
    expect(text).toContain("推理强度")
    // 中文名在左，英文名贴着右边（样式和上面的档位别名一样）
    expect(items()).toEqual(expect.arrayContaining(["默认", "低LOW", "高HIGH", "最高MAX"]))
  })
  test("默认项在环境变量里设了强度时写明；当前强度不在选项里时选中默认", async () => {
    envDefault = "max"
    await render({ session: { ...session, effort: "ultra" } as SessionSummary })
    await openMenu()
    expect(items()).toContain("默认（环境变量：max）")
    const checked = Array.from(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')).map((el) => el.textContent)
    expect(checked.some((text) => text?.startsWith("默认（环境变量"))).toBe(true)
  })
  test("点一档就 POST /effort", async () => {
    await render()
    await openMenu()
    const low = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent === "低LOW") as HTMLElement
    await act(async () => low.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(posts).toEqual([{ url: "/api/sessions/demo/effort", body: { effort: "low" } }])
  })
  test("没有选项（比如 codex 的自定义模型）就没有这一组", async () => {
    levels = []
    await render()
    await openMenu()
    expect(document.body.textContent).not.toContain("推理强度")
  })
  test("有缓存时第一次打开菜单就有，不等服务端", async () => {
    window.localStorage.setItem("manyoyo:effort-levels", JSON.stringify({ "demo\u0000": { levels: ["low"], envDefault: "" } }))
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
    await act(async () => root.render(<ModelMenu session={session} disabled={false} onChanged={() => {}} />))
    await openMenu()
    expect(items()).toContain("低LOW")
  })
  test("codex / claude 以外的 Agent 不请求也没有这一组", async () => {
    await render({ session: { ...session, agentProgram: "gemini" } as SessionSummary })
    await openMenu()
    expect(document.body.textContent).not.toContain("推理强度")
  })
})

describe("ContextMeter", () => {
  const usage = { usedTokens: 580_000, window: 1_000_000, inputTokens: 46, cacheReadTokens: 4416, cacheCreationTokens: 0, updatedAt: null }
  test("没数据不显示；桌面显示“用量 · 百分比”；手机只显示百分比", async () => {
    await act(async () => root.render(<ContextMeter usage={null} />))
    expect(container.textContent).toBe("")
    await act(async () => root.render(<ContextMeter usage={usage} />))
    expect(container.textContent).toBe("580k · 58%")
    await act(async () => root.render(<ContextMeter usage={usage} compact />))
    expect(container.textContent).toBe("58%")
    expect(container.querySelector("button")!.getAttribute("aria-label")).toContain("580k · 58%")
    await act(async () => root.render(<ContextMeter usage={{ ...usage, usedTokens: 4500 }} compact />))
    expect(container.textContent).toBe("<1%")
  })
})
