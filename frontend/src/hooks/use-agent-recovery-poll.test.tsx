import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ChatMessage, SessionSummary } from "@/lib/api"
import { useAgentRecoveryPoll } from "./use-agent-recovery-poll"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { name: "c~a" } as SessionSummary
const pendingMessages = [{ id: "1", role: "assistant", content: "", timestamp: "", pending: true }] as ChatMessage[]

function Harness({ onTick, messages }: { onTick: () => Promise<unknown>; messages: ChatMessage[] }) {
  useAgentRecoveryPoll(session, messages, onTick)
  return null
}

let container: HTMLDivElement
let root: Root
let visibility = "visible"

function setVisibility(value: string) {
  visibility = value
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe("useAgentRecoveryPoll", () => {
  test("页面隐藏期间不发请求，切回可见时立刻补一次，退避计数不清零", async () => {
    const onTick = vi.fn(async () => {})
    await act(async () => {
      root.render(<Harness onTick={onTick} messages={pendingMessages} />)
    })
    await advance(1500)
    expect(onTick).toHaveBeenCalledTimes(1)

    visibility = "hidden"
    await advance(120_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    await act(async () => setVisibility("visible"))
    expect(onTick).toHaveBeenCalledTimes(2)

    // 退避没有清零：第三次要等 3000ms，而不是回到 1500ms
    await advance(1500)
    expect(onTick).toHaveBeenCalledTimes(2)
    await advance(1500)
    expect(onTick).toHaveBeenCalledTimes(3)
  })

  test("没有 pending 消息时不轮询", async () => {
    const onTick = vi.fn(async () => {})
    await act(async () => {
      root.render(<Harness onTick={onTick} messages={[]} />)
    })
    await advance(60_000)
    expect(onTick).not.toHaveBeenCalled()
  })
})
