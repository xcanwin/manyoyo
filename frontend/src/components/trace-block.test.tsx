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

describe("TraceBlock 默认展开与全部开合（B2–B4）", () => {
  const mk = (extra: unknown[] = []): ChatMessage =>
    ({
      id: "1700000000000-eeeeee",
      role: "assistant",
      content: "[执行过程]",
      timestamp: "2026-01-01T00:00:00Z",
      streamTrace: true,
      traceEvents: [
        { kind: "agent_message", text: "说明", detail: "先看看目录结构" },
        {
          kind: "tool",
          toolName: "Bash",
          toolId: "t1",
          text: "[工具完成] Bash (success)",
          phase: "completed",
          status: "success",
          arguments: { command: "ls -la", description: "列出目录", timeout: 12000 },
          result: "total 8",
        },
        ...extra,
      ],
    }) as ChatMessage

  const button = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click()
    })
  }
  const toolRow = () => Array.from(container.querySelectorAll("button[data-slot='collapsible-trigger']")).find((el) => el.textContent?.includes("[工具] Bash")) as HTMLElement

  test("展开整段后：说明默认展开，工具行直接显示描述，其余（命令 / 结果）点开这一行才显示", async () => {
    await mount(mk())
    await expand()
    expect(container.textContent).toContain("先看看目录结构")
    expect(container.textContent).toContain("列出目录")
    expect(container.textContent).not.toContain("total 8")
    expect(container.textContent).not.toContain("ls -la")
    await click(toolRow())
    expect(container.textContent).toContain("total 8")
    expect(container.textContent).toContain("ls -la")
  })

  test("工具行标题是一行：[工具] Bash ✅ 描述；不再显示“[工具完成] Bash (success)”，超出一行用省略号", async () => {
    await mount(mk())
    await expand()
    const row = toolRow()
    const title = row.querySelector("span.truncate") as HTMLElement
    expect(title.textContent).toBe("[工具] Bash ✅ 列出目录")
    expect(container.textContent).not.toContain("[工具完成]")
    expect(title.className).toContain("truncate")
  })

  test("展开全部细节 / 收起全部细节：按钮在两个对齐按钮之间，标题随状态切换", async () => {
    await mount(mk())
    await expand()
    const labels = Array.from(container.querySelectorAll("button[aria-label]")).map((el) => el.getAttribute("aria-label"))
    const up = labels.indexOf("执行过程对齐到顶部")
    const down = labels.indexOf("执行过程对齐到底部")
    const all = labels.indexOf("展开全部细节")
    expect(up).toBeLessThan(all)
    expect(all).toBeLessThan(down)

    await click(button("展开全部细节")!)
    expect(container.textContent).toContain("total 8")
    expect(button("收起全部细节")).not.toBeNull()
    expect(button("展开全部细节")).toBeNull()

    await click(button("收起全部细节")!)
    expect(container.textContent).not.toContain("total 8")
    expect(container.textContent).not.toContain("先看看目录结构")
    // 描述已经写在工具行标题里（一行），收起全部后仍然看得到这一行标题
    expect(button("展开全部细节")).not.toBeNull()
  })

  test("用户手动开合过的行，后续新事件到来时不会被改回默认", async () => {
    await mount(mk())
    await expand()
    await click(toolRow())
    expect(container.textContent).toContain("total 8")
    await act(async () => {
      root.render(<TraceBlock trace={mk([{ kind: "tool", toolName: "Read", toolId: "t2", text: "Read: a", result: "新结果" }])} sessionName="c~a" />)
    })
    expect(container.textContent).toContain("total 8")
    expect(container.textContent).not.toContain("新结果")
  })
})

describe("TraceBlock 工具参数（B5）", () => {
  const msg = {
    id: "1700000000000-ffffff",
    role: "assistant",
    content: "[执行过程]",
    timestamp: "2026-01-01T00:00:00Z",
    streamTrace: true,
    traceEvents: [
      {
        kind: "tool",
        toolName: "Bash",
        toolId: "t1",
        text: "Bash: ls",
        arguments: { command: "ls -la", description: "列出目录", timeout: 12000, note: "a\nb" },
        result: "ok",
      },
    ],
  } as ChatMessage

  test("叫“工具参数”，紧跟在“工具”后面、在命令之前，单行 键=值；点一下展开全文；不再出现“其他参数”", async () => {
    await mount(msg)
    await expand()
    const row = Array.from(container.querySelectorAll("button[data-slot='collapsible-trigger']")).find((el) => el.textContent?.includes("[工具] Bash")) as HTMLElement
    await act(async () => {
      row.click()
    })
    // 只看这一行点开后的详情（标题里也有“[工具]”字样，不能拿整页文字比顺序）
    const text = row.parentElement?.querySelector("[data-slot='collapsible-content']")?.textContent || ""
    expect(text).not.toContain("其他参数")
    expect(text).toContain("工具参数")
    expect(text).toContain("timeout=12000 note=a b")
    const order = ["描述", "工具", "工具参数", "命令", "结果"].map((label) => text.indexOf(label))
    expect(order.every((value) => value >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(container.querySelector("pre")?.textContent).not.toContain("{")
  })
})
