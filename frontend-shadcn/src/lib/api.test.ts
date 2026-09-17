import { describe, expect, test } from "vitest"

import {
  applyServerMessageIds,
  applyTraceEventUpdate,
  isStreamConnectionError,
  LOCAL_USER_MESSAGE_ID_PREFIX,
  mergeToolTraceEvents,
  mergeTraceIntoReply,
  removeLocalPendingPlaceholders,
  shouldDiscardMessagesResponse,
  STREAMING_MESSAGE_ID,
  STREAMING_TRACE_ID,
  summarizeTraceFlow,
} from "./api"

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

// 回归用例：发送提示词后，本地乐观占位（local-* user / __streaming_trace__ /
// __streaming__）的 id 与服务端持久化消息 id 不一致。轮询对账一旦用服务端快照
// 整体替换 messages，React key 全部变化 → 整个消息列表 DOM 重建，移动端表现为
// 代码块横向滚动位置被清零、选中文字被打断。收到 meta/result 事件里的服务端 id
// 后应原地替换占位 id，对账时 key 保持稳定。
describe("applyServerMessageIds", () => {
  function localUserMessages() {
    return [
      { id: "server-old-1", role: "assistant" as const, content: "历史回复", timestamp: "t0" },
      { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}1`, role: "user" as const, content: "新提示词", timestamp: "t1" },
      { id: STREAMING_TRACE_ID, role: "assistant" as const, content: "[执行过程]", streamTrace: true, traceEvents: [], pending: true, timestamp: "t2" },
      { id: STREAMING_MESSAGE_ID, role: "assistant" as const, content: "流式回复", pending: true, timestamp: "t3" },
    ]
  }

  test("meta 事件：替换最新一条 local user 与 trace 占位的 id，其余不动", () => {
    const result = applyServerMessageIds(localUserMessages(), {
      userMessageId: "server-user-9",
      traceMessageId: "server-trace-9",
    })
    expect(result.map((m) => m.id)).toEqual(["server-old-1", "server-user-9", "server-trace-9", STREAMING_MESSAGE_ID])
    // 除 id 外的字段保持不变
    expect(result[1].content).toBe("新提示词")
    expect(result[2].streamTrace).toBe(true)
  })

  test("result 事件：替换流式回复占位的 id", () => {
    const result = applyServerMessageIds(localUserMessages(), { replyMessageId: "server-reply-9" })
    expect(result.map((m) => m.id)).toEqual([
      "server-old-1",
      `${LOCAL_USER_MESSAGE_ID_PREFIX}1`,
      STREAMING_TRACE_ID,
      "server-reply-9",
    ])
  })

  test("没有可替换的占位（如 409 冲突时 meta 未到达）：原样返回同一数组内容", () => {
    const messages = [{ id: "server-1", role: "user" as const, content: "x", timestamp: "t" }]
    const result = applyServerMessageIds(messages, { userMessageId: "server-2", replyMessageId: "server-3" })
    expect(result).toEqual(messages)
  })

  test("id 缺失时不替换对应占位", () => {
    const result = applyServerMessageIds(localUserMessages(), {})
    expect(result.map((m) => m.id)).toEqual([
      "server-old-1",
      `${LOCAL_USER_MESSAGE_ID_PREFIX}1`,
      STREAMING_TRACE_ID,
      STREAMING_MESSAGE_ID,
    ])
  })

  test("多轮残留：只替换最后一条 local user", () => {
    const messages = [
      { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}0`, role: "user" as const, content: "旧", timestamp: "t0" },
      { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}1`, role: "user" as const, content: "新", timestamp: "t1" },
    ]
    const result = applyServerMessageIds(messages, { userMessageId: "server-user-9" })
    expect(result.map((m) => m.id)).toEqual([`${LOCAL_USER_MESSAGE_ID_PREFIX}0`, "server-user-9"])
  })
})

// 回归用例：meta 事件到达后会把 trace 占位消息的 id 从 STREAMING_TRACE_ID
// 换成服务端持久化 id（见 applyServerMessageIds），发送方页面因此在整个流式
// 过程中从来不会出现"执行过程"折叠面板——handleSend 里后续的 trace/result
// 事件处理如果继续拿 STREAMING_TRACE_ID 这个常量去匹配 messages，会匹配不到
// 任何消息，traceEvents 永远停在初始空数组，TraceBlock 因为 !merged.length
// 直接 return null。这里验证 applyTraceEventUpdate 必须按调用方传入的
// "当前有效 id"匹配，不能依赖写死的本地乐观 id。
describe("applyTraceEventUpdate", () => {
  test("meta 换 id 之后，仍按调用方传入的当前 id 命中并更新 traceEvents", () => {
    const messages = [
      { id: "server-trace-9", role: "assistant" as const, content: "[执行过程]", streamTrace: true, traceEvents: [] as unknown[], pending: true, timestamp: "t2" },
      { id: STREAMING_MESSAGE_ID, role: "assistant" as const, content: "流式回复", pending: true, timestamp: "t3" },
    ]
    const result = applyTraceEventUpdate(messages, "server-trace-9", { traceEvents: [{ kind: "tool" }] })
    expect(result[0].traceEvents).toEqual([{ kind: "tool" }])
    expect(result[1]).toEqual(messages[1])
  })

  test("继续用已经失效的本地乐观 id 匹配的话，什么都更新不到（复现修复前的 bug）", () => {
    const messages = [
      { id: "server-trace-9", role: "assistant" as const, content: "[执行过程]", streamTrace: true, traceEvents: [] as unknown[], pending: true, timestamp: "t2" },
    ]
    const result = applyTraceEventUpdate(messages, STREAMING_TRACE_ID, { traceEvents: [{ kind: "tool" }] })
    expect(result[0].traceEvents).toEqual([])
  })

  test("meta 还没到达时，用初始的 STREAMING_TRACE_ID 也能正常命中", () => {
    const messages = [
      { id: STREAMING_TRACE_ID, role: "assistant" as const, content: "[执行过程]", streamTrace: true, traceEvents: [] as unknown[], pending: true, timestamp: "t2" },
    ]
    const result = applyTraceEventUpdate(messages, STREAMING_TRACE_ID, { pending: false })
    expect(result[0].pending).toBe(false)
  })
})

// 回归用例：loadMessages 的响应回写是无条件的——发送前发起的轮询请求，其响应在
// 乐观 user 消息 append 之后才回来，会把刚显示的提示词整体覆盖掉（用户看到自己
// 发的消息"消失"）。同理，切换会话后旧会话的 in-flight 响应会把 A 的消息写进 B
// 的界面。回写前必须校验：请求的会话仍是活动会话、且该会话没有正在跑的本地流。
describe("shouldDiscardMessagesResponse", () => {
  test("会话仍活动且未在发送：不丢弃", () => {
    expect(shouldDiscardMessagesResponse("demo", "demo", false)).toBe(false)
  })

  test("请求期间已切到别的会话：丢弃（防止串台）", () => {
    expect(shouldDiscardMessagesResponse("a", "b", false)).toBe(true)
  })

  test("本标签页正为该会话跑 stream：丢弃（防止旧快照覆盖乐观消息）", () => {
    expect(shouldDiscardMessagesResponse("demo", "demo", true)).toBe(true)
  })
})

// 回归用例：POST /agent/stream 被服务端拒绝（如 409 "已有运行中的 agent 任务"）或
// 网络失败时，本地乐观插入的 user 消息（local-*）与流式占位都应清除——服务端
// 根本没收到这条消息，不清除会在界面上留下一条"永远没有回复"的幽灵消息
describe("removeLocalPendingPlaceholders", () => {
  test("清除最新一条 local user 与两个流式占位，保留服务端消息", () => {
    const serverMsg = { id: "s1", role: "assistant" as const, content: "历史", timestamp: "t" }
    const localUser = { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}9`, role: "user" as const, content: "被拒", timestamp: "t" }
    const trace = { id: STREAMING_TRACE_ID, role: "assistant" as const, content: "[执行过程]", streamTrace: true, pending: true, timestamp: "t" }
    const reply = { id: STREAMING_MESSAGE_ID, role: "assistant" as const, content: "", pending: true, timestamp: "t" }
    expect(removeLocalPendingPlaceholders([serverMsg, localUser, trace, reply])).toEqual([serverMsg])
  })

  test("meta 已把占位换成服务端 id 后（无 local-*）：只清除残留占位", () => {
    const user = { id: "server-user", role: "user" as const, content: "x", timestamp: "t" }
    const trace = { id: "server-trace", role: "assistant" as const, content: "", streamTrace: true, pending: true, timestamp: "t" }
    expect(removeLocalPendingPlaceholders([user, trace])).toEqual([user, trace])
  })

  test("多轮残留的旧 local-*：只清最新一条", () => {
    const old1 = { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}1`, role: "user" as const, content: "旧", timestamp: "t1" }
    const new1 = { id: `${LOCAL_USER_MESSAGE_ID_PREFIX}2`, role: "user" as const, content: "新", timestamp: "t2" }
    expect(removeLocalPendingPlaceholders([old1, new1])).toEqual([old1])
  })
})

// agent 静默超过反向代理的空闲读超时（nginx 默认 60s）时，浏览器会把这条 h2 流
// 当成中途重置，fetch 抛出的是浏览器自己的原话（Chrome "network error" /
// "Failed to fetch"，Safari "Load failed"，Firefox "NetworkError ..."）。
// 服务端那一轮任务其实还在容器里正常跑，不该把这串裸错误直接贴给用户看
describe("isStreamConnectionError", () => {
  test("浏览器各家的 fetch 网络失败原话都算连接中断", () => {
    expect(isStreamConnectionError(new TypeError("network error"))).toBe(true)
    expect(isStreamConnectionError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isStreamConnectionError(new TypeError("Load failed"))).toBe(true)
    expect(
      isStreamConnectionError(new TypeError("NetworkError when attempting to fetch resource."))
    ).toBe(true)
  })

  test("流读完却没见过终态事件，同样属于连接中断", () => {
    expect(isStreamConnectionError(new Error("Agent 流式响应未返回结果"))).toBe(true)
  })

  test("服务端明确返回的业务错误不算连接中断，必须原样展示给用户", () => {
    expect(isStreamConnectionError(new Error("当前容器已有运行中的 agent 任务，请等它结束或先停止"))).toBe(false)
    expect(isStreamConnectionError(new Error("prompt 不能为空"))).toBe(false)
    expect(isStreamConnectionError(null)).toBe(false)
  })
})
