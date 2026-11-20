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
let applyResult: Record<string, unknown>

beforeEach(() => {
  applyResult = { warnings: [], conflicts: [] }
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
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url) === "/api/extensions") {
      return new Response(JSON.stringify({
        skills: [{ agent: "common", name: "shared-demo", description: "共享的", updatedAt: "2026-01-01T00:00:00.000Z" }],
        mcp: [{ id: "abc123", name: "echo", agents: ["claude"], transport: "stdio", enabled: true }],
      }))
    }
    if (String(url).includes("/extensions/apply")) return new Response(JSON.stringify(applyResult))
    return new Response(JSON.stringify(payload))
  }))
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
    expect(text).toContain("共享技能在新建容器时通过只读挂载生效")
    // 没有技能 / MCP 的分组给出空状态
    expect(text).toContain("没有技能")
    expect(text).toContain("没有 MCP 服务器")
    // 宿主级共享库
    expect(text).toContain("共享库")
    expect(text).toContain("shared-demo")
    expect(text).toContain("echo")
    expect(text).toContain("同步到当前容器")
    expect(text).toContain("共享 MCP 的密钥会出现在所有使用该条目的容器里")
  })

  test("同步返回 pending:true 时提示未完成、可重试", async () => {
    applyResult = { pending: true, warnings: ['同步共享技能失败: boom'], conflicts: [] }
    await act(async () => root.render(<ExtensionsPanel session={session} />))
    await flush()
    const sync = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("同步到当前容器"))!
    await act(async () => sync.click())
    await flush()
    expect(container.textContent).toContain("同步未完成，可重试")
    expect(container.textContent).not.toContain("已同步")
  })

  test("同步到当前容器：调用 apply 并显示结果", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    await act(async () => root.render(<ExtensionsPanel session={session} />))
    await flush()
    const sync = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("同步到当前容器"))!
    await act(async () => sync.click())
    await flush()
    const applyCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/extensions/apply"))
    expect(applyCall).toBeTruthy()
    expect(container.textContent).toContain("已同步")
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
