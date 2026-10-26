import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { OVERLAY_CLASS } from "./overlay-class"

describe("遮罩淡出", () => {
  test("淡出结束后保持透明（否则面板卸载前整屏闪一下模糊）", () => {
    expect(OVERLAY_CLASS).toContain("data-closed:fill-mode-forwards")
  })

  test("Sheet 遮罩时长与面板一致", () => {
    const src = readFileSync(join(__dirname, "sheet.tsx"), "utf8")
    expect(src).toMatch(/cn\(OVERLAY_CLASS, "duration-200"/)
  })
})
