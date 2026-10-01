import { describe, expect, test } from "vitest"

import { describeUpdate, shouldShowUpdate, type UpdateInfo } from "@/lib/update"

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  enabled: true,
  installMode: "offline",
  current: "7.1.6",
  latest: "8.0.0",
  updateAvailable: true,
  checkedAt: null,
  error: "",
  ...over,
})

describe("shouldShowUpdate", () => {
  test("shows only when enabled, a newer version exists and this version was not dismissed", () => {
    expect(shouldShowUpdate(info(), null)).toBe(true)
    expect(shouldShowUpdate(info(), "7.9.0")).toBe(true)
    expect(shouldShowUpdate(info(), "8.0.0")).toBe(false)
    expect(shouldShowUpdate(info({ updateAvailable: false }), null)).toBe(false)
    expect(shouldShowUpdate(info({ enabled: false }), null)).toBe(false)
    expect(shouldShowUpdate(info({ latest: "" }), null)).toBe(false)
    expect(shouldShowUpdate(null, null)).toBe(false)
  })

  test("a newer release after a dismissal shows again", () => {
    expect(shouldShowUpdate(info({ latest: "8.1.0" }), "8.0.0")).toBe(true)
  })
})

describe("describeUpdate", () => {
  test("names both versions and the two commands", () => {
    const text = describeUpdate(info())
    expect(text).toContain("8.0.0")
    expect(text).toContain("7.1.6")
    expect(text).toContain("manyoyo update")
    expect(text).toContain("--rollback")
  })
})
