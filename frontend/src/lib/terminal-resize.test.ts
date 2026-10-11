import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { canConnectTerminal, createResizeReporter, normalizeReportedSize } from "./terminal-resize"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("canConnectTerminal", () => {
  test("容器尺寸为 0（标签页被隐藏）不建连", () => {
    expect(canConnectTerminal(0, 300)).toBe(false)
    expect(canConnectTerminal(500, 0)).toBe(false)
    expect(canConnectTerminal(500, 300)).toBe(true)
  })
})

describe("normalizeReportedSize", () => {
  test("非整数、非正数、NaN 不上报", () => {
    expect(normalizeReportedSize(80.5, 24)).toBeNull()
    expect(normalizeReportedSize(0, 24)).toBeNull()
    expect(normalizeReportedSize(Number.NaN, 24)).toBeNull()
    expect(normalizeReportedSize(80, 24)).toEqual({ cols: 80, rows: 24 })
  })
  test("超出上限的夹到 500x200", () => {
    expect(normalizeReportedSize(900, 900)).toEqual({ cols: 500, rows: 200 })
  })
})

describe("createResizeReporter", () => {
  test("列数或行数变了才发，带 150ms 防抖，只发最后一次", () => {
    const send = vi.fn(() => true)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(90, 30)
    reporter.report(80, 30)
    reporter.report(70, 30)
    vi.advanceTimersByTime(149)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(70, 30)
  })
  test("与已发送的相同：不发", () => {
    const send = vi.fn(() => true)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(100, 30)
    vi.advanceTimersByTime(500)
    expect(send).not.toHaveBeenCalled()
  })
  test("抖动后回到原值：不发", () => {
    const send = vi.fn(() => true)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(90, 30)
    reporter.report(100, 30)
    vi.advanceTimersByTime(500)
    expect(send).not.toHaveBeenCalled()
  })
  test("只有行数变化也发", () => {
    const send = vi.fn(() => true)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(100, 20)
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledWith(100, 20)
  })
  test("连接还没打开（send 返回 false）：不记为已发送，之后再报会重发", () => {
    let open = false
    const send = vi.fn(() => open)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(90, 30)
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledTimes(1)
    open = true
    reporter.report(90, 30)
    vi.advanceTimersByTime(200)
    expect(send).toHaveBeenCalledTimes(2)
  })
  test("dispose 后不再发送", () => {
    const send = vi.fn(() => true)
    const reporter = createResizeReporter({ cols: 100, rows: 30 }, send)
    reporter.report(90, 30)
    reporter.dispose()
    vi.advanceTimersByTime(500)
    expect(send).not.toHaveBeenCalled()
  })
})
