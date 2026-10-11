import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { TraceBlock } from "./trace-block"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LONG = "完整输出-" + "x".repeat(800)
const SHORT = LONG.slice(0, 200) + "…"

function trace(id: string, truncated: boolean): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "[执行过程]",
    timestamp: "2026-01-01T00:00:00Z",
    streamTrace: true,
    traceTruncated: truncated || undefined,
    traceEvents: [{ kind: "output", stream: "stdout", text: truncated ? SHORT : LONG }],
  } as ChatMessage
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "t", content: "", traceEvents: [{ kind: "output", stream: "stdout", text: LONG }] }), {
      status: 200,
    })
  )
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(message: ChatMessage) {
  await act(async () => {
    root.render(<TraceBlock trace={message} sessionName="c~a" />)
  })
}
async function expand() {
  const trigger = container.querySelector("button, [data-slot='collapsible-trigger']") as HTMLElement
  await act(async () => {
    trigger.click()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe("TraceBlock 按需加载完整内容", () => {
  test("截断版本：折叠时不请求；展开时请求一次 /trace，展开后显示完整内容", async () => {
    await mount(trace("1700000000000-aaaaaa", true))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain(LONG)
    await expand()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/sessions/c~a/messages/1700000000000-aaaaaa/trace")
    expect(container.textContent).toContain(LONG)
  })

  test("完整版本（没有被截断）：展开时不请求", async () => {
    await mount(trace("1700000000000-bbbbbb", false))
    await expand()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain(LONG)
  })

  test("同一条消息只下载一次：重新挂载后展开直接用缓存", async () => {
    await mount(trace("1700000000000-cccccc", true))
    await expand()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(trace("1700000000000-cccccc", true))
    await expand()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(LONG)
  })
})

describe("TraceBlock 复制只给完整内容", () => {
  const FULL_RESULT = "完整结果-" + "r".repeat(800)
  const toolTrace = (id: string): ChatMessage =>
    ({
      id,
      role: "assistant",
      content: "[执行过程]",
      timestamp: "2026-01-01T00:00:00Z",
      streamTrace: true,
      traceTruncated: true,
      traceEvents: [{ kind: "tool", toolName: "Bash", status: "completed", toolId: "t1", result: FULL_RESULT.slice(0, 200) + "…" }],
    }) as ChatMessage

  async function openRows() {
    // 展开执行过程后，再展开里面的每一行，让“结果”代码块出现（已经展开的不再点）
    const rows = Array.from(container.querySelectorAll("button[data-slot='collapsible-trigger'][aria-expanded='false']")).slice(0)
    for (const row of rows) {
      await act(async () => {
        ;(row as HTMLElement).click()
      })
    }
  }

  test("完整内容还没加载回来时没有复制按钮；加载完成后复制的是完整结果", async () => {
    let release: (value: Response) => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    await mount(toolTrace("1700000000000-dddddd"))
    await expand()
    await openRows()
    expect(container.querySelector('[aria-label="复制"]')).toBeNull()
    await act(async () => {
      release(
        new Response(
          JSON.stringify({ id: "x", content: "", traceEvents: [{ kind: "tool", toolName: "Bash", status: "completed", toolId: "t1", result: FULL_RESULT }] })
        )
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    await openRows()
    const copy = container.querySelector('[aria-label="复制"]') as HTMLElement | null
    expect(copy).not.toBeNull()
    await act(async () => {
      copy!.click()
    })
    expect(writeText).toHaveBeenCalledWith(FULL_RESULT)
  })
})
