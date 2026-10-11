import { describe, expect, test } from "vitest"

import { buildDocumentTitle, computeScrollRestore, getBubbleState, isNearBottom, shouldLoadEarlier } from "./chat-behavior"

describe("isNearBottom", () => {
  test("返回 true：滚动条已经在底部（distance = 0）", () => {
    expect(isNearBottom(160, 200, 40, 40)).toBe(true)
  })

  test("返回 true：距离底部正好等于阈值", () => {
    expect(isNearBottom(120, 200, 40, 40)).toBe(true)
  })

  test("返回 false：距离底部超过阈值（用户正在往上翻看历史）", () => {
    expect(isNearBottom(0, 200, 40, 40)).toBe(false)
  })

  test("返回 true：内容本身不足以滚动（scrollHeight <= clientHeight）", () => {
    expect(isNearBottom(0, 40, 200, 40)).toBe(true)
  })

  test("未传阈值时默认使用 48px（对齐 workspace-panel.tsx 的调用方式）", () => {
    expect(isNearBottom(160, 200, 40)).toBe(true)
    expect(isNearBottom(100, 200, 40)).toBe(false)
  })
})

describe("buildDocumentTitle", () => {
  test("有 agent 名时拼接标题", () => {
    expect(buildDocumentTitle("AGENT 1")).toBe("AGENT 1 · MANYOYO Web")
  })

  test("未传/空字符串时回退默认标题", () => {
    expect(buildDocumentTitle("")).toBe("MANYOYO Web")
    expect(buildDocumentTitle()).toBe("MANYOYO Web")
  })

  test("仅空白字符时回退默认标题", () => {
    expect(buildDocumentTitle("   ")).toBe("MANYOYO Web")
  })
})

describe("getBubbleState", () => {
  test("user 消息不受 pending 影响：不变淡、有内容就能复制", () => {
    expect(getBubbleState({ role: "user", content: "你好", pending: true })).toEqual({ faded: false, copyable: true })
    expect(getBubbleState({ role: "user", content: "你好" })).toEqual({ faded: false, copyable: true })
  })
  test("user 消息没有内容时不可复制", () => {
    expect(getBubbleState({ role: "user", content: "", pending: true })).toEqual({ faded: false, copyable: false })
  })
  test("assistant 保持现状：pending 时变淡且不可复制", () => {
    expect(getBubbleState({ role: "assistant", content: "x", pending: true })).toEqual({ faded: true, copyable: false })
    expect(getBubbleState({ role: "assistant", content: "x" })).toEqual({ faded: false, copyable: true })
    expect(getBubbleState({ role: "assistant", content: "", pending: false })).toEqual({ faded: false, copyable: false })
  })
})

describe("shouldLoadEarlier", () => {
  test("滚到顶部附近、还有更早的、没在加载：触发", () => {
    expect(shouldLoadEarlier({ scrollTop: 10, hasMore: true, loading: false })).toBe(true)
    expect(shouldLoadEarlier({ scrollTop: 80, hasMore: true, loading: false })).toBe(true)
  })
  test("离顶部远 / 没有更多 / 正在加载：不触发", () => {
    expect(shouldLoadEarlier({ scrollTop: 400, hasMore: true, loading: false })).toBe(false)
    expect(shouldLoadEarlier({ scrollTop: 0, hasMore: false, loading: false })).toBe(false)
    expect(shouldLoadEarlier({ scrollTop: 0, hasMore: true, loading: true })).toBe(false)
  })
})

describe("computeScrollRestore", () => {
  test("前面插入内容后，滚动位置补上增加的高度，视野不跳动", () => {
    expect(computeScrollRestore({ prevScrollHeight: 1000, nextScrollHeight: 2500, scrollTop: 20 })).toBe(1520)
  })
  test("高度没增加：不变", () => {
    expect(computeScrollRestore({ prevScrollHeight: 1000, nextScrollHeight: 1000, scrollTop: 20 })).toBe(20)
  })
})
