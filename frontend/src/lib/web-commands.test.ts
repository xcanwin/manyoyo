import { describe, expect, test } from "vitest"

import { lastAgentReply, listWebCommands, matchWebCommand } from "@/lib/web-commands"

describe("matchWebCommand", () => {
  test("注册名精确匹配，后面可跟参数", () => {
    expect(matchWebCommand("/model", "claude")).toMatchObject({ command: { name: "model" }, args: "" })
    expect(matchWebCommand("  /diff  ", "codex")).toMatchObject({ command: { name: "diff" }, args: "" })
    expect(matchWebCommand("/status extra words", "claude")).toMatchObject({ command: { name: "status" }, args: "extra words" })
  })
  test("名字只是前缀、不在注册表里、不是以 / 开头：不拦截", () => {
    expect(matchWebCommand("/modelx", "claude")).toBeNull()
    expect(matchWebCommand("/unknown-skill do it", "claude")).toBeNull()
    expect(matchWebCommand("请执行 /model", "claude")).toBeNull()
    expect(matchWebCommand("/", "claude")).toBeNull()
    expect(matchWebCommand("", "claude")).toBeNull()
  })
  test("大小写敏感：/Model 不拦截", () => {
    expect(matchWebCommand("/Model", "claude")).toBeNull()
  })
  test("/effort 只适用于 claude、codex，参数是级别", () => {
    expect(matchWebCommand("/effort high", "claude")).toMatchObject({ command: { name: "effort" }, args: "high" })
    expect(matchWebCommand("/effort", "codex")).toMatchObject({ command: { name: "effort" }, args: "" })
    expect(matchWebCommand("/effort high", "gemini")).toBeNull()
  })
  test("/btw 带问题（保留多行），/btwx 不拦截", () => {
    expect(matchWebCommand("/btw 秘密词是什么", "claude")).toMatchObject({ command: { name: "btw" }, args: "秘密词是什么" })
    expect(matchWebCommand("/btw 第一行\n第二行", "codex")?.args).toBe("第一行\n第二行")
    expect(matchWebCommand("/btw", "claude")?.args).toBe("")
    expect(matchWebCommand("/btw x", "gemini")).toBeNull()
    expect(matchWebCommand("/btwx 问", "claude")).toBeNull()
  })
  test("换行后的参数也算参数", () => {
    expect(matchWebCommand("/copy\nmore", "claude")).toMatchObject({ command: { name: "copy" }, args: "more" })
  })
})

describe("listWebCommands", () => {
  test("每个 Agent 都有基础命令，说明是中文一句话", () => {
    for (const program of ["claude", "codex", "gemini", "opencode", ""]) {
      const names = listWebCommands(program).map((item) => item.name)
      expect(names).toEqual(expect.arrayContaining(["model", "status", "diff", "clear", "copy"]))
    }
    listWebCommands("claude").forEach((item) => expect(item.description).toMatch(/[一-龥]/))
  })
})

describe("lastAgentReply", () => {
  test("取最后一条已完成的 Agent 回复，跳过执行中、执行过程和系统命令输出", () => {
    expect(
      lastAgentReply([
        { role: "assistant", mode: "agent", content: "第一条" },
        { role: "assistant", mode: "agent", content: "第二条" },
        { role: "assistant", mode: "agent", content: "还在写", pending: true },
        { role: "assistant", mode: "agent", content: "trace", streamTrace: true },
        { role: "assistant", mode: "command", content: "ls 输出" },
        { role: "user", mode: "agent", content: "问题" },
      ])
    ).toBe("第二条")
    expect(lastAgentReply([])).toBe("")
  })
})
