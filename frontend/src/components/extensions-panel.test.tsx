import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { ExtensionsPanel } from "@/components/extensions-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "demo", containerName: "demo", agentId: "default" } as SessionSummary
let container: HTMLDivElement
let root: Root
let payload: unknown

beforeEach(() => {
  payload = {
    agents: [
      {
        program: "claude",
        label: "Claude Code",
        skills: [
          { name: "playwright-cli", source: "user", description: "Automate browser" },
          { name: "evil", source: "project", description: "<img src=x onerror=alert(1)>" },
        ],
        mcp: [
          { name: "demo", detail: "npx demo-mcp", status: "Connected", tone: "success" },
          { name: "web", detail: "https://x.test/mcp", status: "Failed to connect", tone: "error" },
        ],
      },
      { program: "codex", label: "Codex CLI", skills: [], mcp: [] },
    ],
  }
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload))))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

describe("技能与 MCP 面板", () => {
  test("按 Agent 分组列出技能（来源中文）和 MCP（状态徽章），说明当纯文本显示", async () => {
    await act(async () => root.render(<ExtensionsPanel session={session} />))
    await flush()
    const text = container.textContent ?? ""
    expect(text).toContain("Claude Code")
    expect(text).toContain("Codex CLI")
    expect(text).toContain("playwright-cli")
    expect(text).toContain("用户")
    expect(text).toContain("项目")
    expect(text).toContain("Connected")
    expect(text).toContain("Failed to connect")
    // 注入内容只当文字
    expect(container.querySelector("img")).toBeNull()
    expect(text).toContain("<img src=x onerror=alert(1)>")
    // 底部说明
    expect(text).toContain("容器里看不到宿主机的 skill")
    // 没有技能 / MCP 的分组给出空状态
    expect(text).toContain("没有技能")
    expect(text).toContain("没有 MCP 服务器")
  })

  test("容器里没有任何 Agent：给一句话", async () => {
    payload = { agents: [] }
    await act(async () => root.render(<ExtensionsPanel session={session} />))
    await flush()
    expect(container.textContent).toContain("容器里没有找到 Claude Code 或 Codex CLI")
  })

  test("读取失败显示错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "容器没有运行" }), { status: 400 })))
    await act(async () => root.render(<ExtensionsPanel session={session} />))
    await flush()
    expect(container.textContent).toContain("容器没有运行")
  })
})
