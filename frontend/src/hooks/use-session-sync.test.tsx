import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useSessionSync } from "./use-session-sync"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SyncOnce = (name: string, signal: AbortSignal, forcePage: boolean) => Promise<unknown>
const holder: { requestSync: (manual: boolean, forcePage?: boolean) => Promise<void> } = { requestSync: async () => {} }
const requestSync = (manual: boolean, forcePage?: boolean) => holder.requestSync(manual, forcePage)

function Harness({ name, syncOnce, onNoSession }: { name: string | null; syncOnce: SyncOnce; onNoSession: () => void }) {
  const request = useSessionSync(name, syncOnce, onNoSession)
  React.useEffect(() => {
    holder.requestSync = request
  }, [request])
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(name: string | null, syncOnce: SyncOnce, onNoSession: () => void = () => {}) {
  await act(async () => {
    root.render(<Harness name={name} syncOnce={syncOnce} onNoSession={onNoSession} />)
  })
}
// 单飞内部有几层微任务，多等几轮，不和具体层数耦合
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("useSessionSync", () => {
  test("进入会话时立刻同步一次", async () => {
    const syncOnce = vi.fn<SyncOnce>(async () => {})
    await render("a", syncOnce)
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(1)
    expect(syncOnce.mock.calls[0][0]).toBe("a")
  })

  test("有请求在路上时，定时触发被跳过；主动触发在结束后补跑恰好一次", async () => {
    const gates = [deferred(), deferred(), deferred()]
    let n = 0
    const syncOnce = vi.fn<SyncOnce>(() => gates[n++].promise)
    await render("a", syncOnce)
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(1)
    void requestSync(false)
    void requestSync(false)
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(1)
    void requestSync(true)
    void requestSync(true)
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(1)
    await act(async () => gates[0].resolve())
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(2)
    await act(async () => gates[1].resolve())
    await flush()
    expect(syncOnce).toHaveBeenCalledTimes(2)
  })

  test("forcePage 只作用于下一轮同步", async () => {
    const syncOnce = vi.fn<SyncOnce>(async () => {})
    await render("a", syncOnce)
    await flush()
    await act(async () => {
      await requestSync(true, true)
    })
    await act(async () => {
      await requestSync(true)
    })
    expect(syncOnce.mock.calls.map((call) => call[2])).toEqual([false, true, false])
  })

  test("切换会话时 abort 上一个会话的在途请求，旧会话的补跑不会发生", async () => {
    const signals: AbortSignal[] = []
    const gate = deferred()
    const syncOnce = vi.fn((name: string, signal: AbortSignal) => {
      signals.push(signal)
      return name === "a" ? gate.promise : Promise.resolve()
    })
    await render("a", syncOnce)
    await flush()
    void requestSync(true)
    await render("b", syncOnce)
    await flush()
    expect(signals[0].aborted).toBe(true)
    expect(syncOnce.mock.calls.map((call) => call[0])).toEqual(["a", "b"])
    await act(async () => gate.resolve())
    await flush()
    expect(syncOnce.mock.calls.map((call) => call[0])).toEqual(["a", "b"])
    expect(signals[1].aborted).toBe(false)
  })

  // 审查 #9：没有会话（或别的会话）时请求的 forcePage 不能被下一个会话的首次同步拿去用
  test("forcePage 只属于发出请求时的会话，不会漏给之后进入的会话", async () => {
    const syncOnce = vi.fn<SyncOnce>(async () => {})
    await render(null, syncOnce)
    await flush()
    await act(async () => {
      await requestSync(true, true)
    })
    await render("a", syncOnce)
    await flush()
    expect(syncOnce.mock.calls.map((call) => [call[0], call[2]])).toEqual([["a", false]])
  })

  test("没有会话时调用 onNoSession，且 requestSync 不报错", async () => {
    const syncOnce = vi.fn<SyncOnce>(async () => {})
    const onNoSession = vi.fn()
    await render(null, syncOnce, onNoSession)
    await flush()
    expect(onNoSession).toHaveBeenCalledTimes(1)
    await act(async () => {
      await requestSync(true)
    })
    expect(syncOnce).not.toHaveBeenCalled()
  })
})
