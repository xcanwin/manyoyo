import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useResumeIndicator } from "./use-resume-indicator"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
const probe = {} as { api: ReturnType<typeof useResumeIndicator> }
function Probe() {
  const api = useResumeIndicator()
  React.useEffect(() => {
    probe.api = api
  })
  return null
}
beforeEach(async () => {
  vi.useFakeTimers()
  root = createRoot(document.createElement("div"))
  await act(async () => root.render(<Probe />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe("回到页面的同步提示", () => {
  test("慢：300ms 后显示同步中，完成后显示已同步 1.5 秒再消失", async () => {
    let resolve!: () => void
    await act(async () => probe.api.track(new Promise<void>((r) => (resolve = r)), () => true))
    await advance(200)
    expect(probe.api.phase).toBe("idle")
    await advance(200)
    expect(probe.api.phase).toBe("syncing")
    await act(async () => resolve())
    expect(probe.api.phase).toBe("synced")
    await advance(1600)
    expect(probe.api.phase).toBe("idle")
  })
  test("快：不出现进度线，直接显示已同步", async () => {
    await act(async () => probe.api.track(Promise.resolve(), () => true))
    expect(probe.api.phase).toBe("synced")
  })
  test("失败：不显示已同步", async () => {
    await act(async () => probe.api.track(Promise.reject(new Error("x")), () => false))
    await advance(500)
    expect(probe.api.phase).toBe("idle")
  })
})
