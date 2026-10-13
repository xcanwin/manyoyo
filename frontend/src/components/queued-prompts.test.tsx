import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { QueueItem } from "@/lib/queue"
import { QueuedPrompts } from "./queued-prompts"
import { Composer } from "./workspace-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const item = (id: string, when: QueueItem["when"], text = `提示词${id}`): QueueItem => ({ id, clientMessageId: `c-${id}`, text, when, createdAt: "" })
const byText = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLElement

describe("QueuedPrompts", () => {
  test("排队中气泡：显示内容和时机角标，可取消、可编辑", async () => {
    const onCancel = vi.fn()
    const onEdit = vi.fn()
    await act(async () => {
      root.render(<QueuedPrompts items={[item("1", "turn"), item("2", "step")]} idle={false} onCancel={onCancel} onEdit={onEdit} onContinue={() => {}} />)
    })
    expect(container.querySelectorAll("[data-queued-item]")).toHaveLength(2)
    expect(container.textContent).toContain("排队中 · 这一轮结束后发送")
    expect(container.textContent).toContain("排队中 · 这一步结束后插入")
    expect(container.textContent).not.toContain("继续发送")
    await act(async () => container.querySelectorAll<HTMLElement>("button")[1].click())
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }))
    await act(async () => container.querySelectorAll<HTMLElement>("button")[0].click())
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }))
  })

  test("没有任务在跑、队列还有内容：提示已停止并给“继续发送”", async () => {
    const onContinue = vi.fn()
    await act(async () => {
      root.render(<QueuedPrompts items={[item("1", "turn")]} idle onCancel={() => {}} onEdit={() => {}} onContinue={onContinue} />)
    })
    expect(container.textContent).toContain("已停止，排队中的提示词还在，可以取消或继续")
    await act(async () => byText("继续发送").click())
    expect(onContinue).toHaveBeenCalled()
  })

  test("队列为空什么都不渲染", async () => {
    await act(async () => {
      root.render(<QueuedPrompts items={[]} idle onCancel={() => {}} onEdit={() => {}} onContinue={() => {}} />)
    })
    expect(container.innerHTML).toBe("")
  })
})

describe("Composer 任务进行中", () => {
  const session = { name: "c~a", containerName: "c", agentEnabled: true, agentRunning: true } as never
  const props = (extra: Record<string, unknown> = {}) => ({
    draft: "补充一句",
    onDraftChange: () => {},
    onSend: vi.fn(),
    onStop: vi.fn(),
    mode: "agent" as const,
    onModeChange: () => {},
    disabled: false,
    sending: true,
    session,
    onOpenCliTemplate: () => {},
    onModelChanged: () => {},
    queueWhen: "turn" as const,
    onQueueWhenChange: vi.fn(),
    ...extra,
  })

  test("输入框保持可用，能发送，同时有停止和插入时机下拉", async () => {
    const p = props()
    await act(async () => {
      root.render(<Composer {...p} />)
    })
    expect((container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false)
    expect(byText("发送").hasAttribute("disabled")).toBe(false)
    expect(byText("停止")).toBeDefined()
    await act(async () => byText("发送").click())
    expect(p.onSend).toHaveBeenCalled()
    expect(container.querySelector('[aria-label="选择插入时机"]')).not.toBeNull()
  })

  test("下拉框三个选项，选中后回调", async () => {
    const p = props()
    await act(async () => {
      root.render(<Composer {...p} />)
    })
    await act(async () => (container.querySelector('[aria-label="选择插入时机"]') as HTMLElement).click())
    const options = Array.from(document.querySelectorAll("[role='menuitem']")).map((el) => el.textContent)
    expect(options).toEqual(["立即插入", "当前这一步结束后插入", "这一轮结束后发送"])
    await act(async () => (document.querySelectorAll("[role='menuitem']")[0] as HTMLElement).click())
    expect(p.onQueueWhenChange).toHaveBeenCalledWith("now")
  })

  test("命令模式不显示下拉框，任务进行中发送置灰", async () => {
    await act(async () => {
      root.render(<Composer {...props({ mode: "command" })} />)
    })
    expect(container.querySelector('[aria-label="选择插入时机"]')).toBeNull()
  })
})
