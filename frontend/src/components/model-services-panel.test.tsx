import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ModelServicesPanel } from "@/components/model-services-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVICES = {
  services: [
    { name: "claude-glm", agent: "claude", agentLabel: "Claude Code", providerId: "zhipu", providerLabel: "智谱 GLM", authMode: "key", baseUrl: "", keyEnv: "ANTHROPIC_AUTH_TOKEN", keyTail: "…1111", model: "", quickChatDefault: false },
  ],
  suggestions: [{ from: "claude-glm", agent: "codex", providerId: "zhipu", label: "智谱 GLM 的 Key 也能给 Codex 用" }],
  agents: [
    { id: "claude", label: "Claude Code", providers: [{ id: "zhipu", label: "智谱 GLM", docUrl: "https://x.test", baseUrl: "https://z.test/anthropic", keyEnv: "ANTHROPIC_AUTH_TOKEN", models: [], defaultModel: "", extraEnv: { ENABLE_TOOL_SEARCH: "false" } }] },
    { id: "codex", label: "Codex", providers: [{ id: "zhipu", label: "智谱 GLM", docUrl: "https://x.test", baseUrl: "https://z.test/v1", keyEnv: "OPENAI_API_KEY", models: ["glm-5.3"], defaultModel: "glm-5.3" }] },
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}


let container: HTMLDivElement
let root: Root

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
const byText = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined
const click = async (text: string) => {
  const el = byText(text)
  if (!el) throw new Error(`找不到按钮 ${text}`)
  await act(async () => { el.click() })
  await flush()
}
const typeInto = async (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const pageText = () => document.body.textContent ?? ""

describe("ModelServicesPanel", () => {
  const calls: { method: string; url: string; body: unknown }[] = []
  const post = (url: string) => calls.find((c) => c.method === "POST" && c.url === url)
  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    calls.length = 0
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith("/import-preview")) return jsonResponse({ candidates: [{ id: "codex", agent: "codex", agentLabel: "Codex", providerLabel: "官方", baseUrl: "", model: "", keyTail: "…9999", duplicate: false, invalid: "" }], sources: [] })
      if (method === "POST" && url.endsWith("/import")) return jsonResponse({ ...SERVICES, names: ["codex-local"] })
      if (method === "GET" && url.endsWith("/containers")) return jsonResponse({ containers: ["box-1"] })
      if (method === "GET") return jsonResponse(SERVICES)
      if (url.endsWith("/test")) return jsonResponse({ category: "success", message: "连接成功", detail: "" })
      if (method === "POST") {
        const added = { ...SERVICES.services[0], name: "codex-zhipu", agent: "codex", agentLabel: "Codex", keyTail: "…1111" }
        return jsonResponse({ ...SERVICES, services: [...SERVICES.services, added], name: "codex-zhipu", suggestions: [] })
      }
      return jsonResponse(SERVICES)
    }))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })
  const mount = async (onSaved?: () => void) => {
    await act(async () => root.render(<ModelServicesPanel onSaved={onSaved} />))
    await flush()
  }

  test("列出已有服务（只有 Key 末 4 位）和复用建议，一键添加后自动测试", async () => {
    const onSaved = vi.fn()
    await mount(onSaved)
    expect(pageText()).toContain("Claude Code · 智谱 GLM")
    expect(pageText()).toContain("…1111")
    await click("一键添加")
    await flush()
    expect(post("/api/model-services")?.body).toEqual({ reuseFrom: "claude-glm", agent: "codex" })
    expect(calls.some((c) => c.url === "/api/model-services/codex-zhipu/test")).toBe(true)
    expect(onSaved).toHaveBeenCalled()
    expect(pageText()).toContain("连接成功")
  })

  test("添加：选服务商后只发 providerId，不发地址和变量名", async () => {
    await mount()
    await click("添加模型服务")
    await click("智谱 GLM")
    await typeInto("ms-key", "k-secret-1234")
    await click("保存")
    expect(post("/api/model-services")?.body).toEqual({ agent: "claude", key: "k-secret-1234", providerId: "zhipu" })
  })

  test("没填 Key 不发请求并提示", async () => {
    await mount()
    await click("添加模型服务")
    await click("保存")
    expect(pageText()).toContain("请填写 API Key")
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })

  test("编辑：Key 留空时不发 key", async () => {
    await mount()
    await click("编辑")
    await typeInto("ms-model", "glm-5.3")
    await click("保存")
    const put = calls.find((c) => c.method === "PUT")
    expect(put?.url).toBe("/api/model-services/claude-glm")
    // 有容器还在用旧设置时默认勾选“同时更新”
    expect(put?.body).toEqual({ model: "glm-5.3", baseUrl: "", syncContainers: true })
    expect(pageText()).not.toContain("同时更新")
  })

  test("从本机导入：先预览（只有末 4 位），确认后只发选中的 id", async () => {
    await mount()
    await click("从本机导入")
    expect(pageText()).toContain("…9999")
    await click("导入")
    expect(post("/api/model-services/import")?.body).toEqual({ ids: ["codex"] })
  })

  test("缺附加设置时提示并能一键修复（界面上没有变量名）", async () => {
    const withMissing = { ...SERVICES, services: [{ ...SERVICES.services[0], missingExtraEnv: { ENABLE_TOOL_SEARCH: "false" } }] }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return jsonResponse(method === "PUT" ? SERVICES : withMissing)
    })
    await mount()
    expect(pageText()).toContain("关闭工具搜索")
    expect(pageText()).not.toContain("ENABLE_TOOL_SEARCH")
    await click("一键修复")
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ applyPresetExtras: true })
    expect(pageText()).not.toContain("关闭工具搜索")
  })

  test("删除要先确认，确认后才请求", async () => {
    await mount()
    await click("删除")
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    const confirm = Array.from(document.body.querySelectorAll("button")).filter((el) => el.textContent?.trim() === "删除").pop()!
    await act(async () => { confirm.click() })
    await flush()
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/model-services/claude-glm")
  })
})
