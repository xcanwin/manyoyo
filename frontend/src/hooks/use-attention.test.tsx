import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { useAttention } from "./use-attention"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let hidden = false
const probe = {} as { api: ReturnType<typeof useAttention> }

function Probe(props: { sessions: SessionSummary[]; active: string | null }) {
  const api = useAttention({ sessions: props.sessions, activeSessionName: props.active })
  React.useEffect(() => {
    probe.api = api
  })
  return null
}
const s = (name: string, agentRunning: boolean) => ({ name, agentName: name, agentRemark: "", agentRunning }) as SessionSummary
async function render(sessions: SessionSummary[], active: string | null) {
  await act(async () => root.render(<Probe sessions={sessions} active={active} />))
}
async function setHidden(value: boolean) {
  hidden = value
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
}

beforeEach(() => {
  hidden = false
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe("标签页角标", () => {
  test("当前会话在前台结束不计；页面在后台结束计 1，回到前台并打开它就清零", async () => {
    await render([s("a", true)], "a")
    await act(async () => probe.api.markFinished("a"))
    expect(probe.api.unseenCount).toBe(0)
    await setHidden(true)
    await act(async () => probe.api.markFinished("a"))
    await act(async () => probe.api.markFinished("a"))
    expect(probe.api.unseenCount).toBe(1)
    await setHidden(false)
    expect(probe.api.unseenCount).toBe(0)
  })

  test("其他会话在列表刷新时从执行中变成结束：计入，切过去看了就清掉", async () => {
    await render([s("a", false), s("b", true)], "a")
    await render([s("a", false), s("b", false)], "a")
    expect(probe.api.unseenCount).toBe(1)
    await render([s("a", false), s("b", false)], "b")
    expect(probe.api.unseenCount).toBe(0)
  })
})

describe("审查回归", () => {
  test("记进角标的会话被删掉后，计数随之去掉", async () => {
    await render([s("a", false), s("b", true)], "a")
    await render([s("a", false), s("b", false)], "a")
    expect(probe.api.unseenCount).toBe(1)
    await render([s("a", false)], "a")
    expect(probe.api.unseenCount).toBe(0)
  })
})
