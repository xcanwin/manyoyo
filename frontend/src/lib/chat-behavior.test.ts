import { describe, expect, test } from "vitest"

import { buildDocumentTitle, computeReplyJump, computeScrollRestore, getBubbleState, isNearBottom, shouldLoadEarlier, computeScrollAnchor, anchoredScrollTop, isOwnScroll, isScrollInput, isFollowPaused } from "./chat-behavior"

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

describe("computeScrollAnchor：内容更新时贴着哪里（默认固定不动，只往下追加）", () => {
  const box = { scrollHeight: 3000, clientHeight: 600 }

  test("视野底部贴着内容底部（没滑过或滑到最底）：贴底", () => {
    expect(computeScrollAnchor({ ...box, scrollTop: 2400, traceBottom: null })).toBe("bottom")
    expect(computeScrollAnchor({ ...box, scrollTop: 2399, traceBottom: null })).toBe("bottom")
  })

  test("离底部只差 30px（正在看执行过程的末尾）也不算贴底：固定不动（旧逻辑 48px 阈值会把视野拉走）", () => {
    expect(computeScrollAnchor({ ...box, scrollTop: 2370, traceBottom: null })).toBe("none")
  })

  test("最新执行过程的底部贴着视野底部（点了“对齐到底部”）：贴住执行过程", () => {
    expect(computeScrollAnchor({ ...box, scrollTop: 1400, traceBottom: 2000 })).toBe("trace")
    expect(computeScrollAnchor({ ...box, scrollTop: 1400, traceBottom: 2030 })).toBe("none")
  })

  test("内容不满一屏：贴底", () => {
    expect(computeScrollAnchor({ scrollHeight: 500, clientHeight: 600, scrollTop: 0, traceBottom: null })).toBe("bottom")
  })
})

describe("anchoredScrollTop：按贴住的位置算出新的 scrollTop", () => {
  test("贴底：滚到最底；贴执行过程：让它的底部对齐视野底部；不贴：不动", () => {
    expect(anchoredScrollTop("bottom", { scrollHeight: 4000, clientHeight: 600, traceBottom: null })).toBe(3400)
    expect(anchoredScrollTop("trace", { scrollHeight: 4000, clientHeight: 600, traceBottom: 2500 })).toBe(1900)
    expect(anchoredScrollTop("none", { scrollHeight: 4000, clientHeight: 600, traceBottom: 2500 })).toBeNull()
  })

  test("贴执行过程但它已经收起（找不到）：不动", () => {
    expect(anchoredScrollTop("trace", { scrollHeight: 4000, clientHeight: 600, traceBottom: null })).toBeNull()
  })
})

describe("isOwnScroll：自己补滚动引起的滚动事件不重新判断贴着哪里", () => {
  test("滚动位置等于上次自己设置的值：是自己引起的（快速输入多行时，输入框在这期间又变高，按新尺寸判断会误判成“不贴底”）", () => {
    expect(isOwnScroll(5450, 5450)).toBe(true)
    expect(isOwnScroll(5450.4, 5450)).toBe(true)
  })
  test("位置不同或从没自己设置过：是用户滚的", () => {
    expect(isOwnScroll(5300, 5450)).toBe(false)
    expect(isOwnScroll(5450, null)).toBe(false)
  })
})

describe("跟随的暂停：只有用户在滚动时才暂停，点击不算", () => {
  test("滚轮 / 触摸 / 按键是滚动输入；点击只有点在滚动条（滚动容器本身）上才算", () => {
    expect(isScrollInput("wheel", false)).toBe(true)
    expect(isScrollInput("touch", false)).toBe(true)
    expect(isScrollInput("key", false)).toBe(true)
    expect(isScrollInput("pointer", false)).toBe(false)
    expect(isScrollInput("pointer", true)).toBe(true)
  })

  test("最近 1.5 秒内有滚动输入或选中了文字时暂停补滚动；过了就恢复", () => {
    expect(isFollowPaused({ now: 10_000, lastScrollInputAt: 9_000, hasSelection: false })).toBe(true)
    expect(isFollowPaused({ now: 10_000, lastScrollInputAt: 8_000, hasSelection: false })).toBe(false)
    expect(isFollowPaused({ now: 10_000, lastScrollInputAt: 0, hasSelection: true })).toBe(true)
  })
})

describe("新输出浮钮", () => {
  test("不在底部且内容变高时出现；回到底部附近就消失；内容没变保持原状", async () => {
    const { nextHasNewBelow } = await import("./chat-behavior")
    const far = { scrollTop: 0, clientHeight: 500 }
    expect(nextHasNewBelow(false, { ...far, prevHeight: 2000, scrollHeight: 2100 })).toBe(true)
    expect(nextHasNewBelow(true, { ...far, prevHeight: 2100, scrollHeight: 2100 })).toBe(true)
    expect(nextHasNewBelow(false, { ...far, prevHeight: 2100, scrollHeight: 2100 })).toBe(false)
    expect(nextHasNewBelow(true, { scrollTop: 1580, clientHeight: 500, prevHeight: 2100, scrollHeight: 2100 })).toBe(false)
    expect(nextHasNewBelow(false, { scrollTop: 1600, clientHeight: 500, prevHeight: 2000, scrollHeight: 2100 })).toBe(false)
  })
})

describe("computeReplyJump（“回复开头”浮钮）", () => {
  // 视野 0~600；每一轮：整轮（执行过程 + 回复）的范围、回复的顶部和高度、有没有执行过程
  const view = { top: 0, bottom: 600 }
  const turn = (over: Partial<{ key: string; top: number; bottom: number; replyTop: number; replyHeight: number; hasTrace: boolean }>) => ({
    key: "t1", top: -2000, bottom: 900, replyTop: -400, replyHeight: 1300, hasTrace: true, ...over,
  })

  test("在回复里读到一半、回复开头在视野上方：向上", () => {
    expect(computeReplyJump({ view, turns: [turn({})] })).toEqual({ key: "t1", direction: "up" })
  })

  test("用力上滑越过了回复开头、视野停在执行过程里：向下", () => {
    expect(computeReplyJump({ view, turns: [turn({ top: -800, bottom: 2200, replyTop: 900, replyHeight: 1300 })] })).toEqual({ key: "t1", direction: "down" })
  })

  test("回复开头就在视野里：不显示", () => {
    expect(computeReplyJump({ view, turns: [turn({ top: -800, bottom: 1500, replyTop: 200, replyHeight: 1300 })] })).toBeNull()
  })

  test("短回复、没有执行过程：不打扰", () => {
    expect(computeReplyJump({ view, turns: [turn({ hasTrace: false, replyHeight: 300, top: -500, bottom: 100, replyTop: -200 })] })).toBeNull()
  })

  test("没有执行过程但回复比视野还高：照样提示", () => {
    expect(computeReplyJump({ view, turns: [turn({ hasTrace: false, top: -400, bottom: 900, replyTop: -400, replyHeight: 1300 })] })).toEqual({ key: "t1", direction: "up" })
  })

  test("多轮同时在视野里：按视野中线所在的那一轮", () => {
    const a = turn({ key: "a", top: -3000, bottom: 100, replyTop: -1200, replyHeight: 1300 })
    const b = turn({ key: "b", top: 120, bottom: 2400, replyTop: 1200, replyHeight: 1200 })
    expect(computeReplyJump({ view, turns: [a, b] })).toEqual({ key: "b", direction: "down" })
  })

  test("整轮都不在视野里：不显示", () => {
    expect(computeReplyJump({ view, turns: [turn({ top: 700, bottom: 3000, replyTop: 1700 })] })).toBeNull()
  })
})
