import { describe, expect, test } from "vitest"

import { rebaseLeafEdits } from "./config-rebase"

const base = `{
    // 注释要保留
    hostPath: "/work/a",
    imageVersion: "1.0.0-common",
    serve: { quickChat: { run: "claude", path: "~/w" }, },
}`

describe("rebaseLeafEdits", () => {
  test("在最新内容上重放自己改过的字段，别人改的字段、注释和尾逗号原样保留", () => {
    const fresh = base.replace('"claude"', '"claude-ds"')
    const out = rebaseLeafEdits(fresh, [{ path: ["hostPath"], valueText: '"/work/b"' }], base)
    expect(out.raw).toContain('hostPath: "/work/b"')
    expect(out.raw).toContain('run: "claude-ds"')
    expect(out.raw).toContain("// 注释要保留")
    expect(out.raw).toContain('path: "~/w" },')
    expect(out.missing).toEqual([])
    expect(out.overridden).toEqual([])
  })
  test("同一个路径改了多次，以最后一次为准", () => {
    const out = rebaseLeafEdits(base, [
      { path: ["hostPath"], valueText: '"/one"' },
      { path: ["imageVersion"], valueText: '"2.0.0-common"' },
      { path: ["hostPath"], valueText: '"/two"' },
    ])
    expect(out.raw).toContain('hostPath: "/two"')
    expect(out.raw).toContain('imageVersion: "2.0.0-common"')
    expect(out.raw).not.toContain('"/one"')
  })
  test("最新内容里已经没有这个字段：记为 missing，其余照常重放", () => {
    const fresh = base.replace('    imageVersion: "1.0.0-common",\n', "")
    const out = rebaseLeafEdits(fresh, [
      { path: ["imageVersion"], valueText: '"2.0.0-common"' },
      { path: ["hostPath"], valueText: '"/work/b"' },
    ])
    expect(out.missing).toEqual(["imageVersion"])
    expect(out.raw).toContain('hostPath: "/work/b"')
  })
  test("同一个字段别人也改了（与打开时不同）：以我的为准，并记在 overridden 里", () => {
    const fresh = base.replace('"/work/a"', '"/work/other"')
    const out = rebaseLeafEdits(fresh, [{ path: ["hostPath"], valueText: '"/work/mine"' }], base)
    expect(out.raw).toContain('hostPath: "/work/mine"')
    expect(out.overridden).toEqual(["hostPath"])
  })
  test("别人没动这个字段：不算 overridden", () => {
    const out = rebaseLeafEdits(base, [{ path: ["hostPath"], valueText: '"/work/mine"' }], base)
    expect(out.overridden).toEqual([])
  })
  test("路径用点连接显示，如 serve.quickChat.run", () => {
    const fresh = base.replace('"claude"', '"x"')
    const out = rebaseLeafEdits(fresh, [{ path: ["serve", "quickChat", "run"], valueText: '"claude-ds"' }], base)
    expect(out.overridden).toEqual(["serve.quickChat.run"])
  })
})
