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

describe("回到页面 / 恢复联网后的同步提示", () => {
  function ResumeHarness({ reconcile, onResumeSync }: { reconcile: (manual: boolean) => Promise<void>; onResumeSync: (p: Promise<void>) => void }) {
    useSyncLoop(reconcile, { onResumeSync })
    return null
  }
  async function mountResume(reconcile: (manual: boolean) => Promise<void>, onResumeSync: (p: Promise<void>) => void) {
    await act(async () => {
      root.render(<ResumeHarness reconcile={reconcile} onResumeSync={onResumeSync} />)
    })
  }
  async function hideFor(ms: number) {
    visibility = "hidden"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await advance(ms)
    visibility = "visible"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await advance(400)
  }

  test("离开超过 5 秒再回来：立刻同步，并把这次同步交给提示", async () => {
    const reconcile = vi.fn(async () => {})
    const onResumeSync = vi.fn()
    await mountResume(reconcile, onResumeSync)
    await hideFor(60_000)
    expect(reconcile).toHaveBeenLastCalledWith(true)
    expect(onResumeSync).toHaveBeenCalledTimes(1)
  })

  test("只离开一下、定时同步、窗口重新聚焦：不提示", async () => {
    const reconcile = vi.fn(async () => {})
    const onResumeSync = vi.fn()
    await mountResume(reconcile, onResumeSync)
    await hideFor(1000)
    await advance(6100)
    await act(async () => window.dispatchEvent(new Event("focus")))
    await advance(400)
    expect(reconcile).toHaveBeenCalled()
    expect(onResumeSync).not.toHaveBeenCalled()
  })

  test("网络恢复（online）：立刻同步并提示", async () => {
    const reconcile = vi.fn(async () => {})
    const onResumeSync = vi.fn()
    await mountResume(reconcile, onResumeSync)
    await act(async () => window.dispatchEvent(new Event("online")))
    await advance(400)
    expect(reconcile).toHaveBeenLastCalledWith(true)
    expect(onResumeSync).toHaveBeenCalledTimes(1)
  })
})

describe("审查回归：回来时的提示不能挂到之后的某次聚焦上", () => {
  test("聚焦先触发了同步，300ms 内才变成可见：这次同步算回来；之后的普通聚焦不提示", async () => {
    function H({ reconcile, onResumeSync }: { reconcile: (m: boolean) => Promise<void>; onResumeSync: (p: Promise<void>) => void }) {
      useSyncLoop(reconcile, { onResumeSync })
      return null
    }
    const reconcile = vi.fn(async () => {})
    const onResumeSync = vi.fn()
    await act(async () => root.render(<H reconcile={reconcile} onResumeSync={onResumeSync} />))
    visibility = "hidden"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await advance(60_000)
    await act(async () => window.dispatchEvent(new Event("focus")))
    visibility = "visible"
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await advance(400)
    const afterResume = onResumeSync.mock.calls.length
    await advance(10_000)
    await act(async () => window.dispatchEvent(new Event("focus")))
    await advance(400)
    expect(afterResume).toBe(1)
    expect(onResumeSync).toHaveBeenCalledTimes(1)
  })
})
