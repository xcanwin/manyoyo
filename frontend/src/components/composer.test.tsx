import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import type { QueueWhen } from "@/lib/queue"
import { Composer } from "./workspace-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = {
  name: "demo", containerName: "demo", agentId: "default", agentName: "AGENT 1", agentRemark: "", containerRemark: "",
  status: "Up", image: "", createdAt: null, updatedAt: null, messageCount: 0, agentEnabled: true, agentProgram: "claude",
  resumeSupported: true, model: "", hostPath: "/w", containerPath: "/w",
} as SessionSummary

let container: HTMLDivElement
let root: Root
let mobile = false
beforeEach(() => {
  mobile = false
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: mobile && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
})

type Props = { draft?: string; sending?: boolean; mode?: "agent" | "command"; queueWhen?: QueueWhen }
async function render(props: Props = {}) {
  const handlers = { onSend: vi.fn(), onStop: vi.fn() }
  await act(async () =>
    root.render(
      <Composer
        draft={props.draft ?? ""}
        onDraftChange={() => {}}
        onSend={handlers.onSend}
        onStop={handlers.onStop}
        mode={props.mode ?? "agent"}
        onModeChange={() => {}}
        disabled={false}
        sending={props.sending ?? false}
        session={session}
        onOpenCliTemplate={() => {}}
        onModelChanged={() => {}}
        queueWhen={props.queueWhen ?? "turn"}
        onQueueWhenChange={() => {}}
      />
    )
  )
  return handlers
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const textarea = () => container.querySelector("textarea") as HTMLTextAreaElement

describe("输入区：按钮都在输入框内，只显示图标，按状态切换", () => {
  test("空闲、没输入：发送禁用，没有停止和插入时机", async () => {
    await render()
    expect(button("发送")?.disabled).toBe(true)
    expect(button("停止")).toBeNull()
    expect(button("插入时机")).toBeNull()
    expect(button("发送")?.textContent?.trim()).toBe("")
  })

  test("空闲、有输入：发送可点", async () => {
    const handlers = await render({ draft: "hi" })
    expect(button("发送")?.disabled).toBe(false)
    await act(async () => button("发送")!.click())
    expect(handlers.onSend).toHaveBeenCalled()
  })

  test("执行中、没输入：只有停止，发送不显示", async () => {
    const handlers = await render({ sending: true })
    expect(button("停止")).not.toBeNull()
    expect(button("发送")).toBeNull()
    expect(button("插入时机")).toBeNull()
    await act(async () => button("停止")!.click())
    expect(handlers.onStop).toHaveBeenCalled()
  })

  test("执行中、有输入、Agent 模式：插入时机 + 停止 + 追加；提示文字写明会怎么发", async () => {
    await render({ sending: true, draft: "再加一句", queueWhen: "step" })
    expect(button("插入时机")).not.toBeNull()
    expect(button("停止")).not.toBeNull()
    expect(button("发送")?.disabled).toBe(false)
    await render({ sending: true, draft: "", queueWhen: "step" })
    expect(textarea().placeholder).toContain("当前这一步结束后插入")
  })

  test("执行中、命令模式：停止 + 发送禁用，没有插入时机", async () => {
    await render({ sending: true, draft: "ls", mode: "command" })
    expect(button("停止")).not.toBeNull()
    expect(button("发送")?.disabled).toBe(true)
    expect(button("插入时机")).toBeNull()
  })

  test("模式与模型按钮带无障碍名称；命令模式隐藏模型按钮", async () => {
    await render()
    expect(button("切换模式")).not.toBeNull()
    expect(container.querySelector('button[aria-label^="选择模型"]')).not.toBeNull()
    await render({ mode: "command" })
    expect(container.querySelector('button[aria-label^="选择模型"]')).toBeNull()
  })

  test("手机上主要按钮的点击区域不小于 40px（size-10）", async () => {
    mobile = true
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true })
    await render({ sending: true, draft: "x" })
    for (const label of ["停止", "发送", "插入时机", "切换模式"]) {
      expect([label, button(label)?.className.includes("size-10")]).toEqual([label, true])
    }
  })
})

describe("输入框补全", () => {
  function Stateful({ onSend, initial = "" }: { onSend: () => void; initial?: string }) {
    const [draft, setDraft] = React.useState(initial)
    return (
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={onSend}
        onStop={() => {}}
        mode="agent"
        onModeChange={() => {}}
        disabled={false}
        sending={false}
        session={session}
        onOpenCliTemplate={() => {}}
        onModelChanged={() => {}}
        queueWhen="turn"
        onQueueWhenChange={() => {}}
      />
    )
  }
  async function type(value: string) {
    const el = textarea()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value)
      el.setSelectionRange(value.length, value.length)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 220)) })
  }
  const key = (k: string) => act(async () => { textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })) })

  test("开头打 / 列出可用命令；Enter 选中而不是发送", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(decodeURIComponent(String(url)))
      if (String(url).includes("/slash-commands")) return new Response(JSON.stringify({ commands: [{ name: "compact", description: "" }, { name: "my-skill", description: "我的技能" }] }))
      return new Response("{}")
    }))
    const onSend = vi.fn()
    await act(async () => root.render(<Stateful onSend={onSend} />))
    await type("/my")
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("/my-skill")
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("我的技能")
    expect(container.querySelector('[role="listbox"]')?.textContent).not.toContain("compact")
    await key("Enter")
    expect(onSend).not.toHaveBeenCalled()
    expect(textarea().value).toBe("/my-skill ")
  })

  test("codex 也能用 /：只有网页命令；网页命令在命令目录回来之前就可选", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commands: [] }))))
    function CodexBox() {
      const [draft, setDraft] = React.useState("")
      return (
        <Composer draft={draft} onDraftChange={setDraft} onSend={() => {}} onStop={() => {}} mode="agent" onModeChange={() => {}}
          disabled={false} sending={false} session={{ ...session, name: "codex-demo", agentProgram: "codex" }} onOpenCliTemplate={() => {}} onModelChanged={() => {}} queueWhen="turn" onQueueWhenChange={() => {}} />
      )
    }
    await act(async () => root.render(<CodexBox />))
    await type("/mo")
    const options = Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent)
    expect(options).toHaveLength(1)
    expect(options[0]).toContain("/model")
    expect(options[0]).toContain("打开模型菜单")
  })

  test("打 @ 按目录和前缀列文件（带数量上限）；选目录继续往下补全，选文件插入相对路径", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = decodeURIComponent(String(url))
      calls.push(u)
      if (u.includes("/fs/list") && u.includes("path=/w/src")) return new Response(JSON.stringify({ entries: [{ name: "app.ts", kind: "file" }] }))
      if (u.includes("/fs/list")) return new Response(JSON.stringify({ entries: [{ name: "src", kind: "directory" }] }))
      return new Response("{}")
    }))
    await act(async () => root.render(<Stateful onSend={() => {}} />))
    await type("看 @sr")
    expect(calls.some((u) => u.includes("/fs/list?path=/w&prefix=sr&limit=50"))).toBe(true)
    await key("Enter")
    expect(textarea().value).toBe("看 @src/")
    await type("看 @src/")
    expect(calls.some((u) => u.includes("path=/w/src&prefix=&limit=50"))).toBe(true)
    await key("Tab")
    expect(textarea().value).toBe("看 src/app.ts ")
  })

  test("Esc 关掉弹层，这时 Enter 照常发送", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commands: [{ name: "compact", description: "" }] }))))
    const onSend = vi.fn()
    await act(async () => root.render(<Stateful onSend={onSend} />))
    await type("/co")
    const options = Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent)
    expect(options.some((text) => text?.startsWith("/compact"))).toBe(true)
    await key("Escape")
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    await key("Enter")
    expect(onSend).toHaveBeenCalled()
  })
})

test("Esc 关掉补全后，继续输入会重新弹出", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commands: [{ name: "compact", description: "" }] }))))
  function Box() {
    const [draft, setDraft] = React.useState("")
    return (
      <Composer draft={draft} onDraftChange={setDraft} onSend={() => {}} onStop={() => {}} mode="agent" onModeChange={() => {}}
        disabled={false} sending={false} session={session} onOpenCliTemplate={() => {}} onModelChanged={() => {}} queueWhen="turn" onQueueWhenChange={() => {}} />
    )
  }
  await act(async () => root.render(<Box />))
  const el = textarea()
  const typeValue = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value)
      el.setSelectionRange(value.length, value.length)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  }
  await typeValue("/co")
  expect(container.querySelector('[role="listbox"]')).not.toBeNull()
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
  expect(container.querySelector('[role="listbox"]')).toBeNull()
  await typeValue("/c")
  expect(container.querySelector('[role="listbox"]')).not.toBeNull()
})

test("@ 后面写绝对路径时按绝对路径列目录", async () => {
  const calls: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(decodeURIComponent(String(url)))
    return new Response(JSON.stringify({ entries: [{ name: "hosts", kind: "file" }] }))
  }))
  function Box() {
    const [draft, setDraft] = React.useState("")
    return (
      <Composer draft={draft} onDraftChange={setDraft} onSend={() => {}} onStop={() => {}} mode="agent" onModeChange={() => {}}
        disabled={false} sending={false} session={session} onOpenCliTemplate={() => {}} onModelChanged={() => {}} queueWhen="turn" onQueueWhenChange={() => {}} />
    )
  }
  await act(async () => root.render(<Box />))
  const el = textarea()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "@/etc/ho")
    el.setSelectionRange(8, 8)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
  expect(calls.some((u) => u.includes("fs/list?path=/etc&prefix=ho"))).toBe(true)
  expect(calls.some((u) => u.includes("path=/w//"))).toBe(false)
})
