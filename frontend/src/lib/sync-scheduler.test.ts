import { describe, expect, test, vi } from "vitest"

import { createCoalescer, createSingleFlight, decideSyncDelay } from "./sync-scheduler"

describe("decideSyncDelay", () => {
  test("可见且有焦点：6 秒", () => {
    expect(decideSyncDelay({ visible: true, focused: true, idleMs: 0 })).toBe(6000)
  })
  test("可见但没焦点：30 秒", () => {
    expect(decideSyncDelay({ visible: true, focused: false, idleMs: 0 })).toBe(30000)
  })
  test("隐藏：暂停", () => {
    expect(decideSyncDelay({ visible: false, focused: true, idleMs: 0 })).toBeNull()
  })
  test("空闲超过 10 分钟：暂停；刚好 10 分钟仍继续", () => {
    expect(decideSyncDelay({ visible: true, focused: true, idleMs: 10 * 60 * 1000 + 1 })).toBeNull()
    expect(decideSyncDelay({ visible: true, focused: true, idleMs: 10 * 60 * 1000 })).toBe(6000)
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("createSingleFlight", () => {
  test("并发的定时触发只发一次，之后不补跑", async () => {
    const d = deferred()
    const fn = vi.fn(() => d.promise)
    const flight = createSingleFlight(fn)
    const a = flight.run(false)
    flight.run(false)
    flight.run(false)
    expect(fn).toHaveBeenCalledTimes(1)
    d.resolve()
    await a
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test("主动触发在请求进行中不丢：结束后补跑恰好一次", async () => {
    const ds = [deferred(), deferred(), deferred()]
    let i = 0
    const fn = vi.fn(() => ds[i++].promise)
    const flight = createSingleFlight(fn)
    const first = flight.run(false)
    const manual1 = flight.run(true)
    flight.run(true)
    expect(fn).toHaveBeenCalledTimes(1)
    ds[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(2)
    ds[1].resolve()
    await Promise.all([first, manual1])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test("空闲时直接执行；结束后可以再次执行", async () => {
    const fn = vi.fn(async () => {})
    const flight = createSingleFlight(fn)
    await flight.run(false)
    await flight.run(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test("fn 抛错不会卡死：下一次仍可执行", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom")
    })
    const flight = createSingleFlight(fn)
    await flight.run(false)
    await flight.run(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test("abort 取消在途请求（signal.aborted）且不补跑，之后可立即重新执行", async () => {
    const signals: AbortSignal[] = []
    const ds = [deferred(), deferred()]
    let i = 0
    const fn = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return ds[i++].promise
    })
    const flight = createSingleFlight(fn)
    flight.run(false)
    flight.run(true)
    flight.abort()
    expect(signals[0].aborted).toBe(true)
    ds[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    flight.run(false)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(signals[1].aborted).toBe(false)
  })
})

describe("createCoalescer", () => {
  test("窗口内的重复触发只执行一次（visibilitychange + focus）", () => {
    let now = 1000
    const handler = vi.fn()
    const call = createCoalescer(300, handler, () => now)
    call()
    now += 100
    call()
    expect(handler).toHaveBeenCalledTimes(1)
    now += 250
    call()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
