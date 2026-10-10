import { describe, expect, it } from "vitest"

import { configLabel } from "@/lib/config-labels"

describe("configLabel", () => {
  it("已登记的键给中文名并保留键名", () => {
    expect(configLabel(["serve", "quickChat", "run"])).toMatchObject({ title: "运行配置", key: "run", mono: false })
  })
  it("env 下的变量名与 run 名原样显示", () => {
    expect(configLabel(["runs", "claude", "env", "ANTHROPIC_MODEL"])).toMatchObject({ title: "ANTHROPIC_MODEL", mono: true })
    expect(configLabel(["runs", "claude"])).toMatchObject({ title: "claude", mono: true })
  })
  it("没登记的键退回键名", () => {
    expect(configLabel(["foo"])).toMatchObject({ title: "foo", key: "foo", mono: true })
  })
})
