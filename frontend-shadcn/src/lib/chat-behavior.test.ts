import { describe, expect, test } from "vitest"

import { buildDocumentTitle, isNearBottom } from "./chat-behavior"

// 与旧版前端 test/chat-behavior.test.js 的 isNearBottom 用例对齐
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

// 与旧版前端 test/chat-behavior.test.js 的 buildDocumentTitle 用例对齐
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
