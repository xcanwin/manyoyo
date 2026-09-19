import { describe, expect, test } from "vitest"

import { formatDateTime } from "./format"

describe("formatDateTime", () => {
  test("固定成 zh-CN 24 小时制紧凑格式，不含年份与秒", () => {
    const text = formatDateTime("2026-09-20T10:12:33.000Z")
    // 具体分隔符由 ICU 决定（09/20 或 09-20），这里只锁"两位月日 + 24 小时制时分"
    expect(text).toMatch(/^\d{2}\D\d{2}\s\d{2}:\d{2}$/)
    expect(text).not.toMatch(/AM|PM|上午|下午/)
    expect(text).not.toContain("2026")
  })

  test("空值返回空串，交给调用方决定占位文案", () => {
    expect(formatDateTime("")).toBe("")
    expect(formatDateTime("   ")).toBe("")
    expect(formatDateTime(null)).toBe("")
    expect(formatDateTime(undefined)).toBe("")
  })

  test("解析不出来的值原样回显，不吞成空白", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date")
  })

  test("接受时间戳数字", () => {
    expect(formatDateTime(Date.parse("2026-09-20T10:12:33.000Z"))).toMatch(
      /^\d{2}\D\d{2}\s\d{2}:\d{2}$/
    )
  })
})
