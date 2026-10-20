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

describe("TraceBlock 执行中的截断 trace 不来回切换", () => {
  test("已经有一份完整版、任务还在跑又来了新事件：直接显示“完整版 + 新事件”，不闪“正在加载完整内容…”，也不重新下载", async () => {
    const id = "1700000000000-grow01"
    const grow = (n: number) =>
      ({
        ...trace(id, true),
        pending: true,
        traceEvents: Array.from({ length: n }, (_, i) => ({ kind: "output", stream: "stdout", text: i === 0 ? SHORT : `第 ${i} 行` })),
      }) as ChatMessage
    await mount(grow(1))
    await expand()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(LONG)
    await act(async () => {
      root.render(<TraceBlock trace={grow(2)} sessionName="c~a" />)
    })
    expect(container.textContent).not.toContain("正在加载完整内容")
    expect(container.textContent).toContain(LONG)
    expect(container.textContent).toContain("第 1 行")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("TraceBlock 截断 trace 下载（审查补充）", () => {
  const grow = (n: number, id = "1700000000000-grow02", pending = true) =>
    ({
      ...trace(id, true),
      pending,
      traceEvents: Array.from({ length: n }, (_, i) => ({ kind: "output", stream: "stdout", text: i === 0 ? SHORT : `第 ${i} 行` })),
    }) as ChatMessage

  test("下载回来的完整版比请求时多：按返回的条数记，列表追上来后不重复显示", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ traceEvents: [{ kind: "output", stream: "stdout", text: LONG }, { kind: "output", stream: "stdout", text: "第 1 行" }, { kind: "output", stream: "stdout", text: "第 2 行" }] }))
    )
    await mount(grow(1))
    await expand()
    await act(async () => {
      root.render(<TraceBlock trace={grow(3)} sessionName="c~a" />)
    })
    expect((container.textContent!.match(/第 2 行/g) || []).length).toBe(1)
  })

  test("执行中还没下载完时新事件不触发重复下载", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    await mount(grow(1, "1700000000000-grow03"))
    await expand()
    for (const n of [2, 3, 4]) {
      await act(async () => {
        root.render(<TraceBlock trace={grow(n, "1700000000000-grow03")} sessionName="c~a" />)
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
    expect(container.textContent).toContain("[说明]")
    expect(container.textContent).not.toContain("total 8")
    expect(container.textContent).not.toContain("ls -la")
    await click(toolRow())
    expect(container.textContent).toContain("total 8")
    expect(container.textContent).toContain("ls -la")
  })

  test("工具行标题只到 [工具] Bash ✅；描述在标题下面单独一段，样式与 [说明] 正文相同；点开这一行后描述只出现一次", async () => {
    await mount(mk())
    await expand()
    const row = toolRow()
    const title = row.querySelector("span.truncate") as HTMLElement
    expect(title.textContent).toBe("[工具] Bash ✅")
    expect(container.textContent).not.toContain("[工具完成]")
    const narration = container.querySelector("[data-trace-narration]") as HTMLElement
    const desc = container.querySelector("[data-trace-desc]") as HTMLElement
    expect(desc.textContent).toBe("列出目录")
    expect(desc.className).toBe(narration.className)
    expect(desc.parentElement!.className).toBe(narration.parentElement!.className)
    await click(toolRow())
    expect(container.querySelector("[data-trace-desc]")).toBeNull()
    expect((container.textContent!.match(/列出目录/g) || []).length).toBe(1)
  })

  test("执行中：正在输出的文字作为最后一行 [说明] 实时显示，标题行带一行预览；正式的说明到了就不再重复", async () => {
    const live = (_unused: string, events: unknown[] = []) =>
      ({ ...mk(events), id: "1700000000000-live01", pending: true }) as ChatMessage
    await act(async () => {
      root.render(<TraceBlock trace={live("")} sessionName="c~a" liveText="正在说第二段" />)
    })
    expect(container.querySelector("[data-trace-block] button")!.textContent).toContain("正在说第二段")
    await expand()
    expect(container.querySelector("[data-trace-live]")!.textContent).toContain("正在说第二段")
    await act(async () => {
      root.render(<TraceBlock trace={live("", [{ kind: "agent_message", text: "说明", detail: "正在说第二段" }])} sessionName="c~a" liveText="正在说第二段" />)
    })
    expect(container.querySelector("[data-trace-live]")).toBeNull()
    // 列表里只剩正式的那一行（标题行的预览照旧）
    const list = container.querySelector("[data-trace-block] [data-slot='collapsible-content']")!
    expect((list.textContent!.match(/正在说第二段/g) || []).length).toBe(1)
  })

  test("正式的说明只有 text（形如“[说明] …”）没有 detail：也认得出，不重复显示", async () => {
    await act(async () => {
      root.render(<TraceBlock trace={{ ...mk([{ kind: "agent_message", text: "[说明] 只有文本" }]), pending: true } as ChatMessage} sessionName="c~a" liveText="只有文本" />)
    })
    await expand()
    expect(container.querySelector("[data-trace-live]")).toBeNull()
  })

  test("执行中还没有任何事件：也显示执行过程（标题行），不是什么都没有", async () => {
    await act(async () => {
      root.render(<TraceBlock trace={{ ...mk(), traceEvents: [], pending: true } as ChatMessage} sessionName="c~a" liveText="" />)
    })
    expect(container.textContent).toContain("执行过程")
  })

  test("展开全部细节 → 隐藏所有细节 → 展开描述：按钮在两个对齐按钮之间，三态循环", async () => {
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
    expect(button("隐藏所有细节")).not.toBeNull()
    expect(button("展开全部细节")).toBeNull()

    await click(button("隐藏所有细节")!)
    expect(container.textContent).not.toContain("total 8")
    expect(container.textContent).not.toContain("先看看目录结构")
    // 收起全部：工具描述与说明正文一样收起，只剩标题
    expect(container.textContent).not.toContain("列出目录")
    expect(button("展开描述")).not.toBeNull()

    await click(button("展开描述")!)
    expect(container.textContent).toContain("列出目录")
    expect(container.textContent).not.toContain("total 8")
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

describe("TraceBlock 子 Agent 与任务清单", () => {
  const msg = (traceEvents: unknown[], pending = false): ChatMessage =>
    ({
      id: "1700000000000-ffffff",
      role: "assistant",
      content: "[执行过程]",
      timestamp: "2026-01-01T00:00:00Z",
      streamTrace: true,
      pending,
      traceEvents,
    }) as ChatMessage
  const sub = { kind: "subagent", text: "x", toolId: "toolu_A", toolName: "Agent", subagentType: "Explore", description: "列文件", phase: "completed", status: "success", result: "共 3 个文件", prompt: "请列出文件" }
  const inner = { kind: "tool", text: "x", toolId: "t1", toolName: "Bash", parentToolId: "toolu_A", phase: "completed", status: "success", arguments: { description: "ls 一下" }, result: "a b c" }
  const rowByText = (text: string) =>
    Array.from(container.querySelectorAll("button[data-slot='collapsible-trigger']")).find((el) => el.textContent?.includes(text)) as HTMLElement | undefined

  test("子 Agent 默认收起，一行标题带步数；点开后才显示它里面的事件，执行过程只数顶层步数", async () => {
    await mount(msg([sub, inner]))
    expect(container.textContent).toContain("执行过程 · 1 步")
    await expand()
    expect(rowByText("[子 Agent] Explore ✅ · 1 步")).toBeDefined()
    expect(container.querySelector("[data-trace-desc]")!.textContent).toBe("列文件")
    expect(container.textContent).not.toContain("ls 一下")
    await act(async () => rowByText("[子 Agent]")!.click())
    expect(container.textContent).toContain("ls 一下")
    expect(container.textContent).toContain("共 3 个文件")
    // 点开后描述在详情里出现一次，标题下面的描述段收起
    expect(container.querySelector("[data-trace-desc]")?.textContent).not.toBe("列文件")
    expect((container.textContent!.match(/列文件/g) || []).length).toBe(1)
  })

  test("展开全部细节覆盖嵌套的行", async () => {
    await mount(msg([sub, inner]))
    await expand()
    await act(async () => (container.querySelector('[aria-label="展开全部细节"]') as HTMLElement).click())
    expect(container.textContent).toContain("a b c")
    expect(container.textContent).toContain("请列出文件")
  })

  test("任务清单区块显示最新状态，超过 8 项折叠", async () => {
    const todos = Array.from({ length: 10 }, (_, i) => ({ content: `任务${i + 1}`, status: i < 2 ? "completed" : "pending" }))
    await mount(msg([{ kind: "tool", text: "x", toolId: "w1", toolName: "TodoWrite", arguments: { todos } }]))
    await expand()
    const block = container.querySelector("[data-task-list]") as HTMLElement
    expect(block.textContent).toContain("任务清单 · 2/10")
    expect(block.textContent).toContain("任务8")
    expect(block.textContent).not.toContain("任务9")
    expect(block.textContent).toContain("还有 2 项")
    expect(rowByText("[任务清单] 更新 10 项")).toBeDefined()
    expect(container.textContent).toContain("[任务清单] 更新 10 项")
  })
})
