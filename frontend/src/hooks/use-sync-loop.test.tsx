import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useSyncLoop } from "./use-sync-loop"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ reconcile }: { reconcile: (manual: boolean) => Promise<void> }) {
  useSyncLoop(reconcile)
  return null
}

let container: HTMLDivElement
let root: Root
let visibility = "visible"
let focused = true

beforeEach(() => {
  vi.useFakeTimers()
  visibility = "visible"
  focused = true
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused })
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
async function mount(reconcile: (manual: boolean) => Promise<void>) {
  await act(async () => {
    root.render(<Harness reconcile={reconcile} />)
  })
}

describe("useSyncLoop", () => {
  test("有焦点时每 6 秒同步一次（定时触发 manual=false）", async () => {
    const reconcile = vi.fn(async () => {})
    await mount(reconcile)
    await advance(5900)
    expect(reconcile).toHaveBeenCalledTimes(0)
    await advance(200)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenLastCalledWith(false)
    await advance(6000)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  test("可见但没有焦点时降到 30 秒一次", async () => {
    focused = false
    const reconcile = vi.fn(async () => {})
    await mount(reconcile)
    await advance(29_000)
    expect(reconcile).toHaveBeenCalledTimes(0)
    await advance(1500)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test("页面隐藏时暂停，切回可见时立刻同步一次（manual=true）", async () => {
    const reconcile = vi.fn(async () => {})
    await mount(reconcile)
    visibility = "hidden"
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await advance(5 * 60_000)
    expect(reconcile).toHaveBeenCalledTimes(0)
    visibility = "visible"
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenLastCalledWith(true)
  })

  test("visibilitychange 与 focus 同时到来只同步一次", async () => {
    const reconcile = vi.fn(async () => {})
    await mount(reconcile)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    // 窗口之外的下一次切回仍然会同步
    await advance(1000)
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  test("上一轮没结束不会叠加请求；结束后才排下一轮", async () => {
    let release: () => void = () => {}
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await mount(reconcile)
    await advance(6100)
    expect(reconcile).toHaveBeenCalledTimes(1)
    await advance(60_000)
    expect(reconcile).toHaveBeenCalledTimes(1)
    await act(async () => release())
    await advance(6100)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  test("空闲超过 10 分钟后暂停，有操作时恢复", async () => {
    const reconcile = vi.fn(async () => {})
    await mount(reconcile)
    await advance(11 * 60_000)
    const calls = reconcile.mock.calls.length
    await advance(60_000)
    expect(reconcile.mock.calls.length).toBe(calls)
    await act(async () => {
      window.dispatchEvent(new Event("mousemove"))
    })
    await advance(6100)
    expect(reconcile.mock.calls.length).toBe(calls + 1)
  })
})
