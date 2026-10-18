import { describe, expect, test } from "vitest"

import { applySuggestion, parseSuggestTrigger } from "./composer-suggest"

describe("输入框补全的触发", () => {
  test("斜杠命令只在开头、还没有空格时触发", () => {
    expect(parseSuggestTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 })
    expect(parseSuggestTrigger("/comp", 5)).toEqual({ kind: "slash", query: "comp", start: 0, end: 5 })
    expect(parseSuggestTrigger("/compact x", 10)).toBeNull()
    expect(parseSuggestTrigger("看看 /etc", 7)).toBeNull()
  })
  test("@ 在开头或空白后触发，拆出目录和名字前缀", () => {
    expect(parseSuggestTrigger("@", 1)).toEqual({ kind: "mention", dir: "", prefix: "", start: 0, end: 1 })
    expect(parseSuggestTrigger("看 @src/comp", 11)).toEqual({ kind: "mention", dir: "src/", prefix: "comp", start: 2, end: 11 })
    expect(parseSuggestTrigger("a@b.com", 7)).toBeNull()
    expect(parseSuggestTrigger("@a b", 4)).toBeNull()
  })
  test("看的是光标前面的内容", () => {
    expect(parseSuggestTrigger("@src 后面", 4)).toMatchObject({ kind: "mention", prefix: "src" })
  })
})

describe("选中候选后的替换", () => {
  test("斜杠命令替换成 /name 加空格", () => {
    const trigger = parseSuggestTrigger("/co", 3)!
    expect(applySuggestion("/co", trigger, "/compact ")).toEqual({ text: "/compact ", caret: 9 })
  })
  test("@ 替换成相对路径，不带 @，光标后面的内容保留", () => {
    const text = "看 @src/co 这个"
    const trigger = parseSuggestTrigger(text, 9)!
    expect(applySuggestion(text, trigger, "src/components/a.ts ")).toEqual({ text: "看 src/components/a.ts  这个", caret: 22 })
  })
  test("选中目录时保留 @，继续往下一层补全", () => {
    const trigger = parseSuggestTrigger("@sr", 3)!
    expect(applySuggestion("@sr", trigger, "@src/")).toEqual({ text: "@src/", caret: 5 })
  })
})

test("@ 后面直接写绝对路径时，目录部分保持绝对路径", () => {
  expect(parseSuggestTrigger("@/etc/ho", 8)).toMatchObject({ kind: "mention", dir: "/etc/", prefix: "ho" })
})
