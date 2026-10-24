import { describe, expect, test } from "vitest"

import type { ChatMessage } from "./api"
import {
  applyMessagesResponse,
  buildMessagesUrl,
  buildTraceUrl,
  createLruCache,
  buildSyncQuery,
  firstServerMessageId,
  getSyncAnchor,
  prependEarlierMessages,
  reconcileWithPage,
  shouldResetAfterSyncError,
  traceCacheKey,
  type MessagesResponse,
} from "./message-sync"

const msg = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "user",
  content: `c-${id}`,
  timestamp: "2026-01-01T00:00:00Z",
  ...extra,
})

function res(messages: ChatMessage[], extra: Partial<MessagesResponse> = {}): MessagesResponse {
  // tail 响应的 firstId 是整份历史的第一条（不是 tail 片段的第一条），默认没有裁剪
  return { messages, epoch: "e1", firstId: null, hasMore: false, mode: "tail", ...extra }
}

describe("buildMessagesUrl", () => {
  test("page / tail / before 三种查询", () => {
    expect(buildMessagesUrl("c~a", { limit: 60 })).toBe("/api/sessions/c~a/messages?limit=60")
    expect(buildMessagesUrl("c~a", { after: "1-ab", epoch: "e1" })).toBe("/api/sessions/c~a/messages?after=1-ab&epoch=e1")
    expect(buildMessagesUrl("c~a", { before: "1-ab", limit: 60 })).toBe("/api/sessions/c~a/messages?before=1-ab&limit=60")
  })
  test("会话名与参数会被转义", () => {
    expect(buildMessagesUrl("a b", { after: "x y", epoch: "e&1" })).toBe(
      "/api/sessions/a%20b/messages?after=x%20y&epoch=e%261"
    )
  })
})

describe("getSyncAnchor", () => {
  test("取第一条 pending 之前的最后一条", () => {
    expect(getSyncAnchor([msg("a"), msg("b"), msg("c", { pending: true }), msg("d")])).toBe("b")
  })
  test("没有 pending：取最后一条", () => {
    expect(getSyncAnchor([msg("a"), msg("b")])).toBe("b")
  })
  test("稳定前缀为空或列表为空：null", () => {
    expect(getSyncAnchor([])).toBeNull()
    expect(getSyncAnchor([msg("a", { pending: true })])).toBeNull()
  })
  test("前缀里有本地占位 id（local-* / result-*）：null，改拉最近一页对账", () => {
    expect(getSyncAnchor([msg("a"), msg("local-123")])).toBeNull()
    expect(getSyncAnchor([msg("a"), msg("result-123", { role: "system" })])).toBeNull()
  })
})

describe("buildSyncQuery", () => {
  test("有 anchor 和 epoch：tail", () => {
    expect(buildSyncQuery([msg("a")], "e1")).toEqual({ after: "a", epoch: "e1" })
  })
  test("没有 epoch 或 anchor：最近一页", () => {
    expect(buildSyncQuery([msg("a")], null)).toEqual({ limit: 60 })
    expect(buildSyncQuery([], "e1")).toEqual({ limit: 60 })
  })
})

describe("applyMessagesResponse", () => {
  test("page / reset：整体替换", () => {
    const local = [msg("a"), msg("b")]
    for (const mode of ["page", "reset"] as const) {
      const out = applyMessagesResponse(local, res([msg("x"), msg("y")], { mode, hasMore: true }), null, false)
      expect(out?.messages.map((m) => m.id)).toEqual(["x", "y"])
      expect(out?.hasMore).toBe(true)
      expect(out?.epoch).toBe("e1")
    }
  })

  test("只改了快照 / 图片 / 拦截标记的消息也要换成服务端版本（不能当成没变而沿用旧对象）", () => {
    const changes: Partial<ChatMessage>[] = [
      { snapBefore: "a".repeat(40) },
      { snapAfter: "b".repeat(40) },
      { snapSkipped: "too-large" },
      { images: ["/run/manyoyo/uploads/x.png"] },
      { networkDenied: { host: "api.example.com", model: true } },
    ]
    for (const change of changes) {
      const local = [msg("a")]
      const out = applyMessagesResponse(local, res([msg("a", change)], { mode: "page" }), null, false)
      expect(out?.messages[0]).toMatchObject(change)
    }
    // 服务端去掉了某个字段，本地也要跟着消失
    const out = applyMessagesResponse([msg("a", { snapSkipped: "too-large" })], res([msg("a")], { mode: "page" }), null, false)
    expect(out?.messages[0].snapSkipped).toBeUndefined()
    // 真的没变时仍然复用旧对象（不重渲染）
    const same = [msg("a", { images: ["/run/manyoyo/uploads/x.png"], networkDenied: { host: "h" } })]
    const kept = applyMessagesResponse(same, res([msg("a", { images: ["/run/manyoyo/uploads/x.png"], networkDenied: { host: "h" } })], { mode: "page" }), null, false)
    expect(kept?.messages).toBe(same)
  })

  test("tail：保留 anchor 及之前，替换之后的部分", () => {
    const local = [msg("a"), msg("b"), msg("c", { pending: true, content: "旧" })]
    const out = applyMessagesResponse(local, res([msg("c", { content: "新" }), msg("d")]), "b", true)
    expect(out?.messages.map((m) => [m.id, m.content])).toEqual([
      ["a", "c-a"],
      ["b", "c-b"],
      ["c", "新"],
      ["d", "c-d"],
    ])
    expect(out?.hasMore).toBe(true)
  })

  test("服务端版本替换本地消息时保留本地的 renderKey（执行过程的 React key 不变，不会重新挂载）", () => {
    const local = [msg("a"), msg("t", { pending: true, streamTrace: true, renderKey: "trace-c1", traceEvents: [] })]
    const out = applyMessagesResponse(local, res([msg("t", { pending: true, streamTrace: true, traceEvents: [{ kind: "output", text: "x" }] })]), "a", false)
    expect(out?.messages[1].renderKey).toBe("trace-c1")
    expect(out?.messages[1].traceEvents?.length).toBe(1)
    const page = reconcileWithPage(local, res([msg("a"), msg("t", { pending: false, streamTrace: true })], { mode: "page" }), false, "e1")
    expect(page.messages[1].renderKey).toBe("trace-c1")
  })

  test("tail 没有变化：返回原数组引用，避免无谓渲染", () => {
    const local = [msg("a"), msg("b")]
    const out = applyMessagesResponse(local, res([]), "b", false)
    expect(out?.messages).toBe(local)
  })

  test("tail：未变化的消息复用原对象，变化的换新", () => {
    const c = msg("c", { pending: true, content: "x" })
    const local = [msg("a"), c]
    const out = applyMessagesResponse(local, res([msg("c", { pending: true, content: "x" }), msg("d")]), "a", false)
    expect(out?.messages[1]).toBe(c)
    const out2 = applyMessagesResponse(local, res([msg("c", { pending: true, content: "xy" })]), "a", false)
    expect(out2?.messages[1]).not.toBe(c)
  })

  test("tail：trace 消息事件数变了就算变化", () => {
    const t = msg("t", { pending: true, streamTrace: true, traceEvents: [{ kind: "tool", text: "1" }] })
    const next = msg("t", { pending: true, streamTrace: true, traceEvents: [{ kind: "tool", text: "1" }, { kind: "tool", text: "2" }] })
    const out = applyMessagesResponse([msg("a"), t], res([next]), "a", false)
    expect(out?.messages[1]).toBe(next)
  })

  test("tail：本地已有完整 trace，服务端返回同一条的截断版：保留本地完整版", () => {
    const full = msg("t", { streamTrace: true, traceEvents: [{ kind: "tool", text: "完整完整完整" }] })
    const truncated = msg("t", { streamTrace: true, traceTruncated: true, traceEvents: [{ kind: "tool", text: "完整…" }] })
    const out = applyMessagesResponse([msg("a"), full], res([truncated]), "a", false)
    expect(out?.messages[1]).toBe(full)
  })

  test("tail：本地是截断版、服务端是完整版（或事件数不同）：换成服务端的", () => {
    const truncated = msg("t", { streamTrace: true, traceTruncated: true, traceEvents: [{ kind: "tool", text: "x…" }] })
    const more = msg("t", { streamTrace: true, traceTruncated: true, traceEvents: [{ kind: "tool", text: "x…" }, { kind: "tool", text: "y" }] })
    const out = applyMessagesResponse([msg("a"), truncated], res([more]), "a", false)
    expect(out?.messages[1]).toBe(more)
  })

  test("tail：按 firstId 去掉服务端已经裁掉的开头", () => {
    const local = [msg("a"), msg("b"), msg("c")]
    const out = applyMessagesResponse(local, res([msg("d")], { firstId: "b" }), "c", false)
    expect(out?.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
  })

  test("tail：firstId 不在列表里（比本地更早）不裁剪", () => {
    const local = [msg("b"), msg("c")]
    const out = applyMessagesResponse(local, res([msg("d")], { firstId: "a" }), "c", false)
    expect(out?.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
  })

  test("tail：本地已经找不到 anchor（期间被改动）：返回 null，丢弃这次结果", () => {
    expect(applyMessagesResponse([msg("a")], res([msg("z")]), "gone", false)).toBeNull()
    expect(applyMessagesResponse([msg("a")], res([msg("z")]), null, false)).toBeNull()
  })

  test("epoch 以响应为准（reset 后换了新 epoch）", () => {
    const out = applyMessagesResponse([msg("a")], res([msg("x")], { mode: "reset", epoch: "e2" }), "a", false)
    expect(out?.epoch).toBe("e2")
  })
})

describe("prependEarlierMessages", () => {
  test("把更早的一页接到前面，按 id 去重，更新 hasMore", () => {
    const local = [msg("c"), msg("d")]
    const out = prependEarlierMessages(local, res([msg("a"), msg("b"), msg("c")], { mode: "page", hasMore: true }))
    expect(out.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"])
    expect(out.hasMore).toBe(true)
  })
  test("空页：不变，hasMore 取响应值", () => {
    const local = [msg("c")]
    const out = prependEarlierMessages(local, res([], { mode: "page", hasMore: false }))
    expect(out.messages).toBe(local)
    expect(out.hasMore).toBe(false)
  })
})

describe("traceCacheKey", () => {
  test("按 会话 + id 区分（不含事件数：执行中新增的事件接在完整版后面，不换 key）", () => {
    expect(traceCacheKey("s", "t1")).toBe(traceCacheKey("s", "t1"))
    expect(traceCacheKey("s", "t1")).not.toBe(traceCacheKey("s2", "t1"))
    expect(traceCacheKey("s", "t1")).not.toBe(traceCacheKey("s", "t2"))
  })
})

describe("reconcileWithPage（流结束、停止、命令执行后的对账）", () => {
  const page = (messages: ChatMessage[], extra: Partial<MessagesResponse> = {}) =>
    res(messages, { mode: "page", firstId: messages[0]?.id ?? null, ...extra })

  test("本地为空：就是这一页", () => {
    const out = reconcileWithPage([], page([msg("a"), msg("b")], { hasMore: true }), false, null)
    expect(out.messages.map((m) => m.id)).toEqual(["a", "b"])
    expect(out.hasMore).toBe(true)
  })
  test("本地多出更早的页：保留更早的，用这一页覆盖重叠部分，hasMore 沿用本地", () => {
    const local = [msg("a"), msg("b"), msg("c", { content: "旧" })]
    const out = reconcileWithPage(local, page([msg("c", { content: "新" }), msg("d")], { hasMore: true }), false, "e1")
    expect(out.messages.map((m) => [m.id, m.content])).toEqual([
      ["a", "c-a"],
      ["b", "c-b"],
      ["c", "新"],
      ["d", "c-d"],
    ])
    expect(out.hasMore).toBe(false)
  })
  test("这一页的开头本地没有：整体替换（含本地占位被服务端真实消息取代）", () => {
    const local = [msg("local-1"), msg("result-2", { role: "system" })]
    const out = reconcileWithPage(local, page([msg("x"), msg("y")], { hasMore: true }), false, null)
    expect(out.messages.map((m) => m.id)).toEqual(["x", "y"])
    expect(out.hasMore).toBe(true)
  })
  test("reset 模式：整体替换，不保留更早的", () => {
    const local = [msg("a"), msg("b")]
    const out = reconcileWithPage(local, res([msg("b"), msg("c")], { mode: "reset", epoch: "e2" }), false, null)
    expect(out.messages.map((m) => m.id)).toEqual(["b", "c"])
    expect(out.epoch).toBe("e2")
  })
  test("内容没变化：返回原数组引用", () => {
    const local = [msg("a"), msg("b")]
    const out = reconcileWithPage(local, page([msg("a"), msg("b")]), false, "e1")
    expect(out.messages).toBe(local)
  })
  // G3 #9：另一个标签页让历史换了 epoch（稳定前缀被改动），本地更早的页可能含已被删掉的消息
  test("本地记录的 epoch 与服务端不同：不保留更早的页，整体替换", () => {
    const local = [msg("a"), msg("b"), msg("c")]
    const out = reconcileWithPage(local, page([msg("c"), msg("d")], { epoch: "e2", hasMore: true }), false, "e1")
    expect(out.messages.map((m) => m.id)).toEqual(["c", "d"])
    expect(out.epoch).toBe("e2")
    expect(out.hasMore).toBe(true)
  })
  // 审查 #8：epoch 未知（首次、400 重置、切走期间流结束）恰好是本地缓存可能陈旧的时候
  test("本地不知道 epoch（null）：同样不保留更早的页", () => {
    const local = [msg("a"), msg("b"), msg("c")]
    const out = reconcileWithPage(local, page([msg("c"), msg("d")], { hasMore: true }), false, null)
    expect(out.messages.map((m) => m.id)).toEqual(["c", "d"])
    expect(out.hasMore).toBe(true)
  })
  test("epoch 相同：照常保留更早的页", () => {
    const local = [msg("a"), msg("b"), msg("c")]
    const out = reconcileWithPage(local, page([msg("c"), msg("d")], { hasMore: true }), false, "e1")
    expect(out.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"])
  })
})

// G3：增量请求（带 after）被服务端以 400 拒绝时，下一次必须改拉最近一页，否则每次轮询都带着同一个坏 anchor
describe("shouldResetAfterSyncError", () => {
  test("带 after 的请求收到 400：重置增量状态", () => {
    expect(shouldResetAfterSyncError(Object.assign(new Error("x"), { status: 400 }), { after: "1-ab", epoch: "e1" })).toBe(true)
  })
  test("最近一页的请求收到 400 / 带 after 但是别的错误：不重置", () => {
    expect(shouldResetAfterSyncError(Object.assign(new Error("x"), { status: 400 }), { limit: 60 })).toBe(false)
    expect(shouldResetAfterSyncError(Object.assign(new Error("x"), { status: 500 }), { after: "1-ab", epoch: "e1" })).toBe(false)
    expect(shouldResetAfterSyncError(new TypeError("Failed to fetch"), { after: "1-ab", epoch: "e1" })).toBe(false)
  })
})

describe("firstServerMessageId", () => {
  test("取第一条服务端消息的 id，跳过本地占位", () => {
    expect(firstServerMessageId([msg("local-1"), msg("a"), msg("b")])).toBe("a")
    expect(firstServerMessageId([msg("__streaming__")])).toBeNull()
    expect(firstServerMessageId([])).toBeNull()
  })
})

describe("buildTraceUrl", () => {
  test("按需加载完整 trace 的地址", () => {
    expect(buildTraceUrl("c~a", "1-ab")).toBe("/api/sessions/c~a/messages/1-ab/trace")
  })
})

describe("createLruCache", () => {
  test("超过上限淘汰最久没用的；读取会刷新使用顺序", () => {
    const cache = createLruCache<number>(2)
    cache.set("a", 1)
    cache.set("b", 2)
    expect(cache.get("a")).toBe(1)
    cache.set("c", 3)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBe(1)
    expect(cache.get("c")).toBe(3)
  })
})
