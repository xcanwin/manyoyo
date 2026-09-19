import { describe, expect, test } from "vitest"

import { applyModifiers, buildMobileSubmitPayload } from "./terminal-input"

describe("applyModifiers", () => {
  test("无修饰键：原样返回", () => {
    expect(applyModifiers("a", false, false)).toBe("a")
  })

  test("ctrl + 字母：转成控制字符", () => {
    expect(applyModifiers("c", true, false)).toBe("\x03")
    expect(applyModifiers("C", true, false)).toBe("\x03")
    expect(applyModifiers("d", true, false)).toBe("\x04")
  })

  test("ctrl + 非字母：原样返回，不乱造控制字符", () => {
    expect(applyModifiers("1", true, false)).toBe("1")
  })

  test("alt + 字符：加 ESC 前缀", () => {
    expect(applyModifiers("b", false, true)).toBe("\x1bb")
  })

  test("多字符（粘贴/输入法整句上屏）不受修饰键影响", () => {
    expect(applyModifiers("ls -la", true, false)).toBe("ls -la")
  })
})

describe("buildMobileSubmitPayload", () => {
  test("普通内容：补一个回车", () => {
    expect(buildMobileSubmitPayload("ls -la", false, false)).toBe("ls -la\r")
  })

  test("空输入：等价于敲一次回车（确认 TUI 提示）", () => {
    expect(buildMobileSubmitPayload("", false, false)).toBe("\r")
  })

  test("单字符 + ctrl：只发控制字符，不再补回车", () => {
    expect(buildMobileSubmitPayload("c", true, false)).toBe("\x03")
  })

  test("单字符 + alt：只发 ESC 序列，不再补回车", () => {
    expect(buildMobileSubmitPayload("b", false, true)).toBe("\x1bb")
  })

  test("多字符 + ctrl：按普通内容处理，仍然补回车", () => {
    expect(buildMobileSubmitPayload("ab", true, false)).toBe("ab\r")
  })

  test("中文内容（输入法整句上屏）照常补回车", () => {
    expect(buildMobileSubmitPayload("你好", false, false)).toBe("你好\r")
  })
})
