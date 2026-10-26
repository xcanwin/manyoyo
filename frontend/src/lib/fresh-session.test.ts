import { beforeEach, describe, expect, test } from "vitest"

import { isFreshSession, markFreshSession, resetFreshSessions, showBottomComposer } from "./fresh-session"

beforeEach(resetFreshSessions)

describe("新建的空会话", () => {
  test("登记后识别，未登记的（分叉、/clear、已有历史）不算", () => {
    markFreshSession("my-easy-1")
    expect(isFreshSession("my-easy-1")).toBe(true)
    expect(isFreshSession("my-easy-2")).toBe(false)
    expect(isFreshSession(undefined)).toBe(false)
  })

  test("创建中、首次加载都不能把输入框放在底部", () => {
    expect(showBottomComposer({ emptyConversation: false, creatingAgent: true, loadingFirst: false })).toBe(false)
    expect(showBottomComposer({ emptyConversation: false, creatingAgent: false, loadingFirst: true })).toBe(false)
    expect(showBottomComposer({ emptyConversation: true, creatingAgent: false, loadingFirst: false })).toBe(false)
    expect(showBottomComposer({ emptyConversation: false, creatingAgent: false, loadingFirst: false })).toBe(true)
  })
})
