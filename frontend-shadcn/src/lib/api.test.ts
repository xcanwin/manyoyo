import { describe, expect, test } from "vitest"

import { mergeToolTraceEvents, mergeTraceIntoReply, summarizeTraceFlow } from "./api"

// 与旧版前端 test/chat-behavior.test.js 的 mergeTraceIntoReply 用例对齐
describe("mergeTraceIntoReply", () => {
  test("trace 紧跟着最终回复：合并成一条，携带 pairedTrace，时间用 trace 的时间", () => {
    const user = { id: "u1", role: "user" as const, content: "", timestamp: "" }
    const trace = {
      id: "t1",
      role: "assistant" as const,
      content: "",
      streamTrace: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    }
    const reply = {
      id: "r1",
      role: "assistant" as const,
      mode: "agent" as const,
      content: "你好",
      timestamp: "2026-01-01T00:00:05.000Z",
    }
    const result = mergeTraceIntoReply([user, trace, reply])
    expect(result).toEqual([
      user,
      { ...reply, timestamp: "2026-01-01T00:00:00.000Z", pairedTrace: trace },
    ])
  })

  test("trace 后面还没有回复（仍在等待）：保持原样，不合并", () => {
    const trace = { id: "t1", role: "assistant" as const, content: "", streamTrace: true, timestamp: "" }
    expect(mergeTraceIntoReply([trace])).toEqual([trace])
  })

  test("trace 后面跟着的不是 assistant 回复：不误合并", () => {
    const trace = { id: "t1", role: "assistant" as const, content: "", streamTrace: true, timestamp: "" }
    const user = { id: "u2", role: "user" as const, content: "", timestamp: "" }
    expect(mergeTraceIntoReply([trace, user])).toEqual([trace, user])
  })

  test("trace 后面跟着另一个 trace：不误合并", () => {
    const trace1 = { id: "t1", role: "assistant" as const, content: "", streamTrace: true, timestamp: "" }
    const trace2 = { id: "t2", role: "assistant" as const, content: "", streamTrace: true, timestamp: "" }
    expect(mergeTraceIntoReply([trace1, trace2])).toEqual([trace1, trace2])
  })

  test("多轮对话：每一对 trace+回复独立合并，互不影响", () => {
    const u1 = { id: "u1", role: "user" as const, content: "", timestamp: "" }
    const t1 = { id: "t1", role: "assistant" as const, content: "", streamTrace: true, timestamp: "t1" }
    const r1 = { id: "r1", role: "assistant" as const, mode: "agent" as const, content: "", timestamp: "r1" }
    const u2 = { id: "u2", role: "user" as const, content: "", timestamp: "" }
    const t2 = { id: "t2", role: "assistant" as const, content: "", streamTrace: true, timestamp: "t2" }
    const r2 = { id: "r2", role: "assistant" as const, mode: "agent" as const, content: "", timestamp: "r2" }
    const result = mergeTraceIntoReply([u1, t1, r1, u2, t2, r2])
    expect(result).toEqual([
      u1,
      { ...r1, timestamp: "t1", pairedTrace: t1 },
      u2,
      { ...r2, timestamp: "t2", pairedTrace: t2 },
    ])
  })

  test("不修改原始消息对象（不产生副作用）", () => {
    const trace = { id: "t1", role: "assistant" as const, content: "", streamTrace: true, timestamp: "t" }
    const reply = { id: "r1", role: "assistant" as const, mode: "agent" as const, content: "", timestamp: "r" }
    mergeTraceIntoReply([trace, reply])
    expect((reply as { pairedTrace?: unknown }).pairedTrace).toBeUndefined()
    expect(reply.timestamp).toBe("r")
    expect(trace.timestamp).toBe("t")
  })

  test("空输入不抛异常", () => {
    expect(mergeTraceIntoReply([])).toEqual([])
  })
})

// 与旧版前端 test/chat-behavior.test.js 的 mergeToolTraceEvents 用例对齐
describe("mergeToolTraceEvents", () => {
  test("空输入不抛异常", () => {
    expect(mergeToolTraceEvents([])).toEqual([])
  })

  test("无匹配 toolId 的单个工具事件：原样保留", () => {
    const events = [{ kind: "tool", toolId: "toolu_1", phase: "started", text: "[工具开始] Bash" }]
    expect(mergeToolTraceEvents(events)).toEqual(events)
  })

  test("同一 toolId 的 started + completed 合并成一条，completed 字段覆盖 started", () => {
    const started = {
      kind: "tool",
      toolId: "toolu_1",
      phase: "started",
      status: "in_progress",
      text: "[工具开始] Bash (command=ls -la)",
      toolName: "Bash",
      arguments: { command: "ls -la" },
      argumentSummary: "command=ls -la",
    }
    const completed = {
      kind: "tool",
      toolId: "toolu_1",
      phase: "completed",
      status: "success",
      text: "[工具完成] Bash (success)",
      toolName: "Bash",
      result: "ok",
    }
    const result = mergeToolTraceEvents([started, completed])
    expect(result).toEqual([
      {
        kind: "tool",
        toolId: "toolu_1",
        phase: "completed",
        status: "success",
        text: "[工具完成] Bash (success)",
        toolName: "Bash",
        arguments: { command: "ls -la" },
        argumentSummary: "command=ls -la",
        result: "ok",
      },
    ])
  })

  test("不同 toolId 的多个工具调用：各自独立保留", () => {
    const a1 = { kind: "tool", toolId: "a", phase: "started", text: "a-start" }
    const b1 = { kind: "tool", toolId: "b", phase: "started", text: "b-start" }
    const a2 = { kind: "tool", toolId: "a", phase: "completed", text: "a-done" }
    const b2 = { kind: "tool", toolId: "b", phase: "completed", text: "b-done" }
    const result = mergeToolTraceEvents([a1, b1, a2, b2])
    expect(result).toEqual([
      { kind: "tool", toolId: "a", phase: "completed", text: "a-done" },
      { kind: "tool", toolId: "b", phase: "completed", text: "b-done" },
    ])
  })

  test("合并后的条目保持在首次出现的位置（不会跳到后面）", () => {
    const agentMessage = { kind: "agent_message", text: "[说明] 我先看看目录" }
    const toolStart = { kind: "tool", toolId: "toolu_1", phase: "started", text: "start" }
    const toolDone = { kind: "tool", toolId: "toolu_1", phase: "completed", text: "done" }
    const finalMessage = { kind: "agent_message", text: "[说明] 完成了" }
    const result = mergeToolTraceEvents([agentMessage, toolStart, finalMessage, toolDone])
    expect(result).toEqual([
      agentMessage,
      { kind: "tool", toolId: "toolu_1", phase: "completed", text: "done" },
      finalMessage,
    ])
  })

  test("无 toolId 的事件（agent_message/thread/turn/error）即使重复也不合并", () => {
    const events = [
      { kind: "agent_message", text: "第一句" },
      { kind: "agent_message", text: "第二句" },
      { kind: "error", text: "出错了" },
      { kind: "error", text: "又出错了" },
    ]
    expect(mergeToolTraceEvents(events)).toEqual(events)
  })

  test("command 和 mcp 两种 kind 同样支持按 toolId 合并（Codex 场景）", () => {
    const cmdStart = { kind: "command", toolId: "item_1", phase: "started", text: "[命令开始] ls -la" }
    const cmdDone = {
      kind: "command",
      toolId: "item_1",
      phase: "completed",
      text: "[命令完成] ls -la (completed)",
      exitCode: 0,
    }
    const mcpStart = { kind: "mcp", toolId: "item_2", phase: "started", text: "[MCP开始] search" }
    const mcpDone = { kind: "mcp", toolId: "item_2", phase: "completed", text: "[MCP完成] search", result: "ok" }
    const result = mergeToolTraceEvents([cmdStart, mcpStart, cmdDone, mcpDone])
    expect(result).toEqual([
      { kind: "command", toolId: "item_1", phase: "completed", text: "[命令完成] ls -la (completed)", exitCode: 0 },
      { kind: "mcp", toolId: "item_2", phase: "completed", text: "[MCP完成] search", result: "ok" },
    ])
  })

  test("不同 kind 使用相同 toolId 不会误合并", () => {
    const toolEvent = { kind: "tool", toolId: "x", phase: "started", text: "tool-x" }
    const commandEvent = { kind: "command", toolId: "x", phase: "started", text: "command-x" }
    expect(mergeToolTraceEvents([toolEvent, commandEvent])).toEqual([toolEvent, commandEvent])
  })

  test("不修改原始事件对象（不产生副作用）", () => {
    const started = { kind: "tool", toolId: "toolu_1", phase: "started", text: "start" }
    const completed = { kind: "tool", toolId: "toolu_1", phase: "completed", text: "done" }
    mergeToolTraceEvents([started, completed])
    expect(started.phase).toBe("started")
    expect(completed.phase).toBe("completed")
  })
})

// summarizeTraceFlow 的签名与旧版 chat-behavior.js 不同（旧版返回 {count,label} 对象、
// 接受 options.pending；shadcn 版直接返回拼好的字符串、pending 是位置参数），
// 按 shadcn 实际实现改写用例，行为语义保持一致
describe("summarizeTraceFlow", () => {
  test("包含错误事件：标记为有错误（优先级最高）", () => {
    const events = [{ kind: "command", text: "" }, { kind: "error", text: "" }, { kind: "tool", text: "" }]
    expect(summarizeTraceFlow(events, true)).toBe("3 步 · 有错误")
  })

  test("仍在执行且无错误：标记为进行中", () => {
    const events = [{ kind: "command", text: "" }, { kind: "tool", text: "" }]
    expect(summarizeTraceFlow(events, true)).toBe("2 步 · 进行中")
  })

  test("已结束且无错误：标记为已完成", () => {
    const events = [{ kind: "command", text: "" }]
    expect(summarizeTraceFlow(events, false)).toBe("1 步 · 已完成")
  })
})
