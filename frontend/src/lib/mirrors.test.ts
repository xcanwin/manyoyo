import { describe, expect, test } from "vitest"

import { CUSTOM_CHOICE, OFFICIAL_CHOICE, choiceFor, isMirrorsEmpty, validateMirrorUrl, validateMirrors } from "@/lib/mirrors"

const presets = [
  { label: "阿里云", value: "https://registry.npmmirror.com/" },
  { label: "腾讯云", value: "https://mirrors.tencent.com/npm/" },
]

describe("mirrors helpers", () => {
  test("choiceFor: empty is official, a preset value selects it, anything else is custom", () => {
    expect(choiceFor("", presets)).toBe(OFFICIAL_CHOICE)
    expect(choiceFor("https://mirrors.tencent.com/npm/", presets)).toBe("https://mirrors.tencent.com/npm/")
    expect(choiceFor("https://my.corp/npm/", presets)).toBe(CUSTOM_CHOICE)
  })

  test("validateMirrorUrl mirrors the server rules", () => {
    expect(validateMirrorUrl("")).toBe("")
    expect(validateMirrorUrl("  ")).toBe("")
    expect(validateMirrorUrl("https://a.com/x")).toBe("")
    expect(validateMirrorUrl("a.com")).toMatch(/http/)
    expect(validateMirrorUrl("ftp://a.com")).toMatch(/http/)
    expect(validateMirrorUrl("https://a.com/a b")).toMatch(/非法字符/)
    expect(validateMirrorUrl("https://a.com/$(id)")).toMatch(/非法字符/)
    expect(validateMirrorUrl(`https://a.com/${"a".repeat(300)}`)).toMatch(/过长/)
  })

  test("validateMirrors names the offending tool; isMirrorsEmpty", () => {
    expect(validateMirrors({ apt: "", npm: "nope", pip: "" })).toMatch(/^npm：/)
    expect(validateMirrors({ apt: "", npm: "", pip: "" })).toBe("")
    expect(isMirrorsEmpty({ apt: "", npm: "", pip: "" })).toBe(true)
    expect(isMirrorsEmpty({ apt: "", npm: "https://a.com", pip: "" })).toBe(false)
  })
})
