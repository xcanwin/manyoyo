import { describe, expect, test } from "vitest"

import {
  applyServerMessageIds,
  applyTraceEventUpdate,
  buildStreamMetaTraceEvents,
  formatComposerModeLabel,
  formatLogExtra,
  isSessionOfContainer,
  isStreamConnectionError,
  LOCAL_USER_MESSAGE_ID_PREFIX,
  logLevelBadgeVariant,
  mergeToolTraceEvents,
  mergeTraceIntoReply,
  nextRecoveryPollDelay,
  removeLocalPendingPlaceholders,
  resolveComposerBlockReason,
  scoreSearchCandidate,
  shouldDiscardMessagesResponse,
  shouldDismissRecoveryNotice,
  toTraceEvent,
  STREAMING_MESSAGE_ID,
  STREAMING_TRACE_ID,
  summarizeTraceFlow,
} from "./api"

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

describe("toTraceEvent", () => {
  test("带结构化 traceEvent：原样返回，不做任何包装", () => {
    const traceEvent = { kind: "tool", toolId: "toolu_1", text: "[工具开始] Bash" }
    expect(toTraceEvent({ text: "[工具开始] Bash", traceEvent })).toBe(traceEvent)
  })

  test("只有 stdout 原始行：兜底成 kind=output 的事件，不丢", () => {
    expect(toTraceEvent({ text: "Loading model...", stream: "stdout" })).toEqual({
      kind: "output",
      stream: "stdout",
      text: "Loading model...",
    })
  })

  test("stderr 行标成 stderr，但 kind 仍是 output——避免无害告警把整轮判成有错误", () => {
    const event = toTraceEvent({ text: "[stderr] warning: deprecated flag", stream: "stderr" })
    expect(event).toEqual({
      kind: "output",
      stream: "stderr",
      text: "[stderr] warning: deprecated flag",
    })
    expect(summarizeTraceFlow([event!], false)).toBe("1 步 · 已完成")
  })

  test("缺省 stream 当 stdout 处理", () => {
    expect(toTraceEvent({ text: "plain line" })?.stream).toBe("stdout")
  })

  test("空行/纯空白不产生事件", () => {
    expect(toTraceEvent({ text: "" })).toBeNull()
    expect(toTraceEvent({ text: "   ", stream: "stderr" })).toBeNull()
    expect(toTraceEvent({})).toBeNull()
  })
})

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

// 回归：删除容器时用 activeSessionName.startsWith(containerName) 判断"当前会话
// 是否属于这个容器"，漏掉了 `~` 分隔符。克隆功能生成的名字正好是 `<name>-copy1`，
// 于是删掉 foo 会把正在 foo-copy1 里聊天的会话一起踢掉
describe("isSessionOfContainer", () => {
  test("默认 AGENT（会话名就是容器名）属于该容器", () => {
    expect(isSessionOfContainer("foo", "foo")).toBe(true)
  })

  test("带 agentId 的会话属于该容器", () => {
    expect(isSessionOfContainer("foo~agent-2", "foo")).toBe(true)
  })

  test("名字以该容器名为前缀的另一个容器不算", () => {
    expect(isSessionOfContainer("foo-copy1", "foo")).toBe(false)
    expect(isSessionOfContainer("foo-copy1~agent-2", "foo")).toBe(false)
    expect(isSessionOfContainer("foobar~default", "foo")).toBe(false)
  })

  test("空值不匹配", () => {
    expect(isSessionOfContainer(null, "foo")).toBe(false)
    expect(isSessionOfContainer("foo", "")).toBe(false)
  })
})

// 回归：切换 AGENT 时草稿会清空（怕把 A 的内容发给 B），但"系统命令 / Agent 对话"
// 模式不会——唯一的提示是输入框 placeholder，一打字就看不见了，很容易在以为
// 跟 agent 说话时把整段文字当 shell 命令丢进容器执行
describe("composer 模式", () => {
  test("模式标签要能在按钮上直接看见，而不是只藏在 placeholder 里", () => {
    expect(formatComposerModeLabel("agent")).toBe("Agent对话")
    expect(formatComposerModeLabel("command")).toBe("系统命令")
  })
})

// 回归：容器级运行锁 + agent 级界面。同容器里别的 AGENT 在跑任务时，
// 当前 AGENT 的输入框此前完全看不出来，点发送必定 409
describe("resolveComposerBlockReason", () => {
  const base = { agentEnabled: true, archived: false, containerBusy: false, agentRunning: false }

  test("一切正常时不拦", () => {
    expect(resolveComposerBlockReason({ ...base }, "agent")).toBe("")
  })

  test("就是自己在跑：不拦（按钮会显示停止）", () => {
    expect(
      resolveComposerBlockReason({ ...base, containerBusy: true, agentRunning: true }, "agent")
    ).toBe("")
  })

  test("同容器别的 AGENT 在跑：拦住并说明原因", () => {
    expect(
      resolveComposerBlockReason({ ...base, containerBusy: true, agentRunning: false }, "agent")
    ).toBe("container-busy")
  })

  test("系统命令模式同样受容器级锁影响", () => {
    expect(
      resolveComposerBlockReason({ ...base, containerBusy: true, agentRunning: false }, "command")
    ).toBe("container-busy")
  })

  test("已删除的 AGENT 优先提示已归档", () => {
    expect(resolveComposerBlockReason({ ...base, archived: true, containerBusy: true }, "agent")).toBe(
      "archived"
    )
  })

  test("未配置 CLI 时只在 agent 模式下拦", () => {
    expect(resolveComposerBlockReason({ ...base, agentEnabled: false }, "agent")).toBe("agent-unavailable")
    expect(resolveComposerBlockReason({ ...base, agentEnabled: false }, "command")).toBe("")
  })
})

// 回归：孤儿 pending（serve 重启后残留的运行标记）会让恢复轮询以固定 1.5 秒
// 无限跑下去，没有上限也没有退避。改成随轮次退避，长时间没人收尾时降到低频
describe("nextRecoveryPollDelay", () => {
  test("前几轮保持灵敏", () => {
    expect(nextRecoveryPollDelay(0)).toBe(1500)
    expect(nextRecoveryPollDelay(1)).toBe(1500)
  })

  test("随轮次退避", () => {
    expect(nextRecoveryPollDelay(4)).toBeGreaterThan(1500)
    expect(nextRecoveryPollDelay(10)).toBeGreaterThan(nextRecoveryPollDelay(4))
  })

  test("有上限，不会无限拉长", () => {
    expect(nextRecoveryPollDelay(1000)).toBe(15000)
  })
})

// 回归：搜索框用的是 cmdk 默认的子序列模糊打分，容器名全是相似时间戳时噪音很大
// ——输 "20260917" 会把 "my-easy-20260915-092716"、"my-easy-20260916-044237"
// 也一并排进来（它们都能按子序列匹配上）
describe("scoreSearchCandidate", () => {
  test("子串命中才算匹配", () => {
    expect(scoreSearchCandidate("container:my-easy-20260917-091138", "20260917")).toBe(1)
  })

  test("只能按子序列匹配上的不算", () => {
    expect(scoreSearchCandidate("container:my-easy-20260915-092716", "20260917")).toBe(0)
    expect(scoreSearchCandidate("container:my-easy-20260916-044237", "20260917")).toBe(0)
  })

  test("大小写不敏感", () => {
    expect(scoreSearchCandidate("agent:AGENT 1 demo", "agent 1")).toBe(1)
  })

  test("空搜索词全部命中", () => {
    expect(scoreSearchCandidate("container:whatever", "")).toBe(1)
  })
})

// 回归：断线提示原本要等整轮任务跑完（pending 消失）才撤掉。可是断线后恢复轮询
// 立刻就把内容同步回来了，界面明明在正常更新，"正在重新同步…"却还挂在输入框上方
// 好几分钟。应该是"断线之后成功对上一次账"就撤掉，而不是等任务结束
describe("shouldDismissRecoveryNotice", () => {
  const base = { recoverable: true, sending: false, syncTick: 5, errorSyncTick: 3 }

  test("断线后成功对账过一次就撤掉提示", () => {
    expect(shouldDismissRecoveryNotice({ ...base })).toBe(true)
  })

  // 判据里刻意不包含"是否还有 pending 消息"：任务跑多久都不该影响这条提示，
  // 只要同步恢复了就撤。这也是这次回归的根因——原来要等 pending 清空
  test("只看对账进度，不看任务有没有跑完", () => {
    expect(shouldDismissRecoveryNotice({ ...base, syncTick: 4 })).toBe(true)
    expect(shouldDismissRecoveryNotice({ ...base, syncTick: 999 })).toBe(true)
  })

  test("还没对上账就不撤，避免本地占位刚清掉的那一瞬间提示一闪而过", () => {
    expect(shouldDismissRecoveryNotice({ ...base, syncTick: 3 })).toBe(false)
    expect(shouldDismissRecoveryNotice({ ...base, syncTick: 2 })).toBe(false)
  })

  test("本标签页正在重新发送时不撤", () => {
    expect(shouldDismissRecoveryNotice({ ...base, sending: true })).toBe(false)
  })

  test("不是可恢复类错误（如 409）不受此逻辑影响，要一直显示", () => {
    expect(shouldDismissRecoveryNotice({ ...base, recoverable: false })).toBe(false)
  })
})

// 运行日志视图的两个纯函数：级别配色必须用语义变体（跟随亮/暗主题），
// 附加字段按 key=value 展开，对象兜底成 JSON 而不是 [object Object]
describe("运行日志渲染", () => {
  test("级别对应的 Badge 变体", () => {
    expect(logLevelBadgeVariant("ERROR")).toBe("destructive")
    expect(logLevelBadgeVariant("WARN")).toBe("outline")
    expect(logLevelBadgeVariant("INFO")).toBe("secondary")
    expect(logLevelBadgeVariant("")).toBe("secondary")
  })

  test("附加字段展开成 key=value", () => {
    expect(
      formatLogExtra({ session: "demo", elapsedMs: 1200, runContinues: true })
    ).toEqual(["session=demo", "elapsedMs=1200", "runContinues=true"])
  })

  test("嵌套对象用 JSON 兜底，空值用占位符", () => {
    expect(formatLogExtra({ applied: { a: 1 }, missing: null })).toEqual([
      'applied={"a":1}',
      "missing=—",
    ])
  })

  test("没有附加字段时返回空数组", () => {
    expect(formatLogExtra(undefined)).toEqual([])
    expect(formatLogExtra({})).toEqual([])
  })
})

describe("buildStreamMetaTraceEvents", () => {
  test("上下文模式与 resume 成功各落一条 status", () => {
    expect(
      buildStreamMetaTraceEvents({ contextMode: "resume", resumeAttempted: true, resumeSucceeded: true })
    ).toEqual([
      { kind: "status", text: "[任务] 上下文模式: resume" },
      { kind: "status", text: "[任务] 会话恢复成功" },
    ])
  })

  test("resume 失败要明说回退到历史注入", () => {
    const events = buildStreamMetaTraceEvents({ resumeAttempted: true, resumeSucceeded: false })
    expect(events).toEqual([{ kind: "status", text: "[任务] 会话恢复失败，已回退到历史注入" }])
  })

  test("没尝试 resume 时不产生 resume 那条", () => {
    expect(buildStreamMetaTraceEvents({ contextMode: "inject" })).toEqual([
      { kind: "status", text: "[任务] 上下文模式: inject" },
    ])
  })

  test("meta 里什么都没有时不产生任何事件（不给摘要凭空加步数）", () => {
    expect(buildStreamMetaTraceEvents({})).toEqual([])
    expect(buildStreamMetaTraceEvents({ contextMode: "   " })).toEqual([])
  })

  test("合成的 status 不会把整轮判成有错误", () => {
    const events = buildStreamMetaTraceEvents({ contextMode: "resume" })
    expect(summarizeTraceFlow(events, false)).toBe("1 步 · 已完成")
  })
})
