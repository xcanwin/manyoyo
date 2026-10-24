import JSON5 from "json5"
import { describe, expect, test } from "vitest"

import { rebaseLeafEdits } from "@/lib/config-rebase"
import { upsertTopLevelValue } from "@/lib/json5-path-edit"

describe("upsertTopLevelValue", () => {
  test("字段已存在：只替换它的值，注释原样保留", () => {
    const out = upsertTopLevelValue('{\n    // 我的注释\n    "imageName": "a", // 行尾\n    "x": 1\n}\n', "imageName", '"b"')
    expect(out).toContain("// 我的注释")
    expect(out).toContain("// 行尾")
    expect(JSON5.parse(out)).toEqual({ imageName: "b", x: 1 })
  })

  test("字段不存在：插在根对象开头，已有内容和注释不动，结果仍可解析", () => {
    const out = upsertTopLevelValue('{\n    // 注释\n    "x": 1,\n    runs: {}\n}\n', "imageVersion", '"2.3.0-common"')
    expect(out).toContain("// 注释")
    expect(JSON5.parse(out)).toEqual({ imageVersion: "2.3.0-common", x: 1, runs: {} })
  })

  test("空对象、同一行的空对象、完全空的文件", () => {
    expect(JSON5.parse(upsertTopLevelValue("{}", "a", "1"))).toEqual({ a: 1 })
    expect(JSON5.parse(upsertTopLevelValue("{\n}\n", "a", "1"))).toEqual({ a: 1 })
    expect(JSON5.parse(upsertTopLevelValue("", "a", '"v"'))).toEqual({ a: "v" })
    expect(JSON5.parse(upsertTopLevelValue("  \n", "a", '"v"'))).toEqual({ a: "v" })
  })

  test("键名里有特殊字符也会被转义；连续插入多个", () => {
    let out = "{}"
    out = upsertTopLevelValue(out, "a", "1")
    out = upsertTopLevelValue(out, "b", '"x"')
    out = upsertTopLevelValue(out, 'we"ird', "true")
    expect(JSON5.parse(out)).toEqual({ a: 1, b: "x", 'we"ird': true })
  })

  test("不是对象开头的文本不动", () => {
    expect(upsertTopLevelValue("[1]", "a", "1")).toBe("[1]")
  })
})

describe("rebaseLeafEdits：自己新填的顶层字段", () => {
  test("打开时没有、最新内容里也没有：补上；留空（空串）的不补", () => {
    const base = '{\n    "x": 1\n}\n'
    const fresh = '{\n    "x": 2\n}\n'
    const result = rebaseLeafEdits(fresh, [
      { path: ["imageName"], valueText: '"my/img"' },
      { path: ["hostPath"], valueText: '""' },
    ], base)
    expect(JSON5.parse(result.raw)).toEqual({ x: 2, imageName: "my/img" })
    expect(result.missing).toEqual([])
  })

  test("打开时有、被别人删掉的字段仍然记为 missing（不悄悄加回去）", () => {
    const base = '{\n    "hostPath": "/a"\n}\n'
    const result = rebaseLeafEdits("{\n}\n", [{ path: ["hostPath"], valueText: '"/b"' }], base)
    expect(result.missing).toEqual(["hostPath"])
    expect(JSON5.parse(result.raw)).toEqual({})
  })
})
