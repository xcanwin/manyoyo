import dialogSrc from "./dialog.tsx?raw"
import { describe, expect, test } from "vitest"

describe("全屏弹窗", () => {
  test("手机全屏弹窗顶部避让安全区", () => {
    const full = dialogSrc.split("\n").filter((l) => /^\s+(lg|xl|wide): "/.test(l))
    expect(full).toHaveLength(3)
    for (const line of full) expect(line).toContain("env(safe-area-inset-top)")
  })
})
