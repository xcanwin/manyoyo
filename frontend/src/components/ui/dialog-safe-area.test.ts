import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

describe("全屏弹窗", () => {
  test("手机全屏弹窗顶部避让安全区", () => {
    const src = readFileSync(join(__dirname, "dialog.tsx"), "utf8")
    const full = src.split("\n").filter((l) => /^\s+(lg|xl|wide): "/.test(l))
    expect(full).toHaveLength(3)
    for (const line of full) expect(line).toContain("env(safe-area-inset-top)")
  })
})
