import { describe, expect, test } from "vitest"

import {
  cacheHitPercent,
  contextReadout,
  formatTokens,
  idleHint,
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
  test("空闲不到 5 分钟不提示；之后用“可能”措辞", () => {
    const t0 = Date.parse("2026-10-25T10:00:00.000Z")
    expect(idleHint("2026-10-25T10:00:00.000Z", t0 + 4 * 60000)).toBe("")
    expect(idleHint("2026-10-25T10:00:00.000Z", t0 + 12 * 60000)).toBe("已空闲 12 分钟，下次发送可能要重新缓存（更贵）")
    expect(idleHint("2026-10-25T10:00:00.000Z", t0 + 130 * 60000)).toContain("2 小时")
    expect(idleHint(null, t0)).toBe("")
    expect(idleHint("bad", t0)).toBe("")
  })
})
