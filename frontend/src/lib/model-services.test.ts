import { describe, expect, test } from "vitest"

import {
  runLabel,
  runLabelMap,
  buildCreateBody,
  buildEditBody,
  CLAUDE_MODEL_FIELDS,
  EMPTY_CLAUDE_MODELS,
  EMPTY_SERVICE_FORM,
  serviceTitle,
  validateServiceForm,
} from "@/lib/model-services"

const form = (over = {}) => ({ ...EMPTY_SERVICE_FORM, ...over })

describe("validateServiceForm", () => {
  test("新增：Key、服务商 / 地址、Codex 的模型", () => {
    expect(validateServiceForm(form(), "create")).toMatch(/Key/)
    expect(validateServiceForm(form({ key: "k" }), "create")).toMatch(/服务商/)
    expect(
      validateServiceForm(form({ key: "k", baseUrl: "ftp://x" }), "create")
    ).toMatch(/http/)
    expect(
      validateServiceForm(form({ key: "k", providerId: "zhipu" }), "create")
    ).toBe("")
    expect(
      validateServiceForm(
        form({ agent: "codex", key: "k", baseUrl: "https://x.test/v1" }),
        "create"
      )
    ).toMatch(/模型/)
    expect(
      validateServiceForm(
        form({
          agent: "codex",
          key: "k",
          baseUrl: "https://x.test/v1",
          model: "m",
        }),
        "create"
      )
    ).toBe("")
  })
  test("编辑：Key 可以留空", () => {
    expect(validateServiceForm(form({ providerId: "zhipu" }), "edit")).toBe("")
  })
  test("订阅登录：Base URL 选填但填了要合法；编辑时令牌可留空", () => {
    expect(validateServiceForm(form({ mode: "subscription", key: "t", baseUrl: "gw" }), "create")).toMatch(/http/)
    expect(validateServiceForm(form({ mode: "subscription", baseUrl: "https://gw.test" }), "edit")).toBe("")
  })
  test("订阅登录：Claude 要令牌，Codex 不在这里保存", () => {
    expect(
      validateServiceForm(form({ mode: "subscription" }), "create")
    ).toMatch(/令牌/)
    expect(
      validateServiceForm(form({ mode: "subscription", key: "t" }), "create")
    ).toBe("")
    expect(
      validateServiceForm(
        form({ mode: "subscription", agent: "codex", key: "t" }),
        "create"
      )
    ).toMatch(/终端/)
  })
})

describe("请求体", () => {
  test("选了服务商只发 providerId，不发地址；自定义地址发 baseUrl；订阅发 subscription", () => {
    expect(buildCreateBody(form({ key: " k ", providerId: "zhipu" }))).toEqual({
      agent: "claude",
      key: "k",
      providerId: "zhipu",
    })
    expect(
      buildCreateBody(form({ key: "k", baseUrl: " https://x.test " }))
    ).toEqual({ agent: "claude", key: "k", baseUrl: "https://x.test" })
    expect(buildCreateBody(form({ key: "t", mode: "subscription" }))).toEqual({
      agent: "claude",
      key: "t",
      subscription: true,
    })
    expect(buildCreateBody(form({ key: "t", mode: "subscription", baseUrl: " https://gw.test ", model: "m" }))).toEqual({
      agent: "claude",
      key: "t",
      subscription: true,
      baseUrl: "https://gw.test",
      model: "m",
    })
    expect(buildEditBody(form({ mode: "subscription", baseUrl: "https://gw.test" }))).toMatchObject({ subscription: true, baseUrl: "https://gw.test" })
  })
  test("编辑：Key 留空不发 key", () => {
    expect(
      buildEditBody(form({ baseUrl: "https://x.test", model: "m" }))
    ).toMatchObject({ model: "m", baseUrl: "https://x.test" })
    expect(buildEditBody(form({ key: "new", baseUrl: "" }))).toMatchObject({
      model: "",
      key: "new",
      baseUrl: "",
    })
    expect(buildEditBody(form({ agent: "codex" }))).toEqual({ model: "", baseUrl: "" })
    expect(buildEditBody(form({ key: "new" }), true)).toMatchObject({
      syncContainers: true,
    })
  })
  test("Claude：带上档位模型和自动压缩大小（空串 = 不设置 / 删除）；Codex 不带", () => {
    const models = { ...EMPTY_CLAUDE_MODELS, ANTHROPIC_DEFAULT_FABLE_MODEL: " top " }
    expect(
      buildEditBody(form({ models, autoCompactWindow: " 5000000 " }))
    ).toMatchObject({
      models: { ANTHROPIC_DEFAULT_FABLE_MODEL: "top", ANTHROPIC_DEFAULT_OPUS_MODEL: "" },
      autoCompactWindow: "5000000",
    })
    expect(buildEditBody(form({ models }))).toMatchObject({ autoCompactWindow: "" })
    expect(buildCreateBody(form({ key: "k", providerId: "anthropic", models, autoCompactWindow: "1000000" }))).toMatchObject({
      models: { ANTHROPIC_DEFAULT_FABLE_MODEL: "top" },
      autoCompactWindow: "1000000",
    })
    expect(buildEditBody(form({ agent: "codex", models }))).not.toHaveProperty("models")
    expect(buildCreateBody(form({ agent: "codex", key: "k", providerId: "zhipu", models }))).not.toHaveProperty("models")
    expect(CLAUDE_MODEL_FIELDS.map((item) => item.label.slice(0, 2))).toEqual(["顶级", "高级", "标准", "轻量", "子 "])
  })
})

test("serviceTitle", () => {
  expect(
    serviceTitle({ agentLabel: "Claude Code", providerLabel: "智谱 GLM" })
  ).toBe("Claude Code · 智谱 GLM")
})

test("runLabelMap：模型服务显示成“Agent · 服务商（配置名）”，其它运行配置显示原名", () => {
  const labels = runLabelMap([
    {
      name: "claude-glm",
      agentLabel: "Claude Code",
      providerLabel: "智谱 GLM",
    },
  ])
  expect(runLabel("claude-glm", labels)).toBe(
    "Claude Code · 智谱 GLM（claude-glm）"
  )
  expect(runLabel("other", labels)).toBe("other")
})
