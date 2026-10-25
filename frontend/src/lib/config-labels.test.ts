import { describe, expect, it } from "vitest"

import { configLabel, envLabel } from "@/lib/config-labels"

describe("configLabel", () => {
  it("已登记的键给中文名并保留键名", () => {
    expect(configLabel(["serve", "quickChat", "run"])).toMatchObject({ title: "运行配置", key: "run", mono: false })
  })
  it("env 下登记过的变量名给中文名并保留键名", () => {
    expect(configLabel(["runs", "claude", "env", "ANTHROPIC_MODEL"])).toMatchObject({ title: "Claude 模型", key: "ANTHROPIC_MODEL", mono: false })
    expect(configLabel(["runs", "c", "env", "https_proxy"])).toMatchObject({ title: "HTTPS 代理", key: "https_proxy", mono: false })
    expect(envLabel("ENABLE_TOOL_SEARCH")).toBe("关闭工具搜索")
  })
  it("env 下没登记的变量名与 run 名原样等宽显示", () => {
    expect(configLabel(["runs", "claude", "env", "MY_CUSTOM_VAR"])).toMatchObject({ title: "MY_CUSTOM_VAR", mono: true })
    expect(envLabel("MY_CUSTOM_VAR")).toBeUndefined()
    expect(configLabel(["runs", "claude"])).toMatchObject({ title: "claude", mono: true })
  })
  it("没登记的键退回键名", () => {
    expect(configLabel(["foo"])).toMatchObject({ title: "foo", key: "foo", mono: true })
  })
})
