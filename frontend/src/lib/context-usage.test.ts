import { describe, expect, test } from "vitest"

import {
  cacheHitPercent,
  contextReadout,
  formatTokens,
  IDLE_CACHE_NOTE,
  idleSpan,
  usageRows,
  type ContextUsage,
} from "@/lib/context-usage"

const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  usedTokens: 4500,
  window: 1_000_000,
  inputTokens: 46,
  cacheReadTokens: 4416,
  cacheCreationTokens: 0,
  updatedAt: "2026-10-25T10:00:00.000Z",
  ...over,
})

describe("上下文占用读数", () => {
  test("formatTokens", () => {
    expect([0, 999, 1000, 4500, 12345, 1_000_000, 1_250_000].map(formatTokens)).toEqual([
      "0",
      "999",
      "1k",
      "4.5k",
      "12.3k",
      "1M",
      "1.3M",
    ])
  })
  test("读数：有窗口显示百分比，不足 1% 写 <1%，窗口未知只显示用量", () => {
    expect(contextReadout(usage())).toBe("4.5k · <1%")
    expect(contextReadout(usage({ usedTokens: 580_000 }))).toBe("580k · 58%")
    expect(contextReadout(usage({ window: 0 }))).toBe("4.5k")
    expect(contextReadout(usage({ usedTokens: 2_000_000 }))).toBe("2M · 100%")
  })
  test("缓存命中 = 缓存读 /（输入 + 缓存读 + 缓存写）", () => {
    expect(cacheHitPercent(usage())).toBe(99)
    expect(cacheHitPercent(usage({ inputTokens: 0, cacheReadTokens: 0 }))).toBeNull()
    expect(cacheHitPercent(usage({ inputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 200 }))).toBe(25)
  })
  test("空闲不到 5 分钟不算；之后给时长，提示用“可能”", () => {
    const t0 = Date.parse("2026-10-25T10:00:00.000Z")
    expect(idleSpan("2026-10-25T10:00:00.000Z", t0 + 4 * 60000)).toBe("")
    expect(idleSpan("2026-10-25T10:00:00.000Z", t0 + 12 * 60000)).toBe("12 分钟")
    expect(idleSpan("2026-10-25T10:00:00.000Z", t0 + 130 * 60000)).toBe("2 小时")
    expect(idleSpan(null, t0)).toBe("")
    expect(idleSpan("bad", t0)).toBe("")
    expect(IDLE_CACHE_NOTE).toContain("可能")
  })
  test("浮层行：名称 + 数据，不重复；缓存命中和空闲只在有数据时才有", () => {
    const t0 = Date.parse("2026-10-25T10:00:00.000Z")
    const rows = usageRows(usage({ usedTokens: 13300, inputTokens: 100, cacheReadTokens: 4900 }), t0 + 21 * 60000)
    expect(rows.map((row) => row.label)).toEqual(["已用上下文", "缓存命中", "已空闲"])
    expect(rows[0].value).toBe("13.3k / 1M（1%）")
    expect(rows[1]).toMatchObject({ value: "98%" })
    expect(rows[2]).toMatchObject({ value: "21 分钟", note: "下次发送可能要重新缓存（更贵）" })
    const fresh = usageRows(usage({ window: 0, inputTokens: 0, cacheReadTokens: 0, usedTokens: 800 }), t0)
    expect(fresh).toEqual([{ label: "已用上下文", value: "800" }])
  })
})
