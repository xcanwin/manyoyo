import { beforeEach, describe, expect, test, vi } from "vitest"

import { loadComposer, type StorageLike } from "./composer-store"
import { beginSend, classifySendError, pickClientId, resolveFailedSend } from "./send-flow"

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size
    },
  }
}

const withStatus = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("x"), { status, data })

describe("classifySendError", () => {
  test("应用层的明确拒绝（400/401/403/404/409/413/422/429），服务端没有执行", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422, 429]) {
      expect(classifySendError(withStatus(status))).toBe("rejected")
    }
  })
  // 审查 #3：反向代理的 5xx / 超时，请求往往已经到了服务端并在执行，不能当作“没发出去”
  test("5xx 网关错误和超时状态码：不确定有没有执行，按网络错误先对账", () => {
    for (const status of [408, 500, 502, 503, 504]) {
      expect(classifySendError(withStatus(status))).toBe("network")
    }
  })
  test("409 且 duplicate:true 是重复提交", () => {
    expect(classifySendError(withStatus(409, { duplicate: true }))).toBe("duplicate")
  })
  test("没有状态码（断网、连接被掐、超时）是网络错误", () => {
    expect(classifySendError(new TypeError("Failed to fetch"))).toBe("network")
    expect(classifySendError(new Error("network error"))).toBe("network")
    expect(classifySendError("boom")).toBe("network")
  })
})

describe("pickClientId", () => {
  const create = () => "fresh-id-0001"
  const restored = { sessionName: "c~a", clientId: "old-id-00001", text: "hello" }
  test("放回的内容原样重发：沿用原 clientId，服务端幂等才能兜住", () => {
    expect(pickClientId("c~a", "hello", restored, create)).toBe("old-id-00001")
  })
  test("改动过就生成新的 clientId", () => {
    expect(pickClientId("c~a", "hello!", restored, create)).toBe("fresh-id-0001")
  })
  test("没有放回过的内容：新 clientId", () => {
    expect(pickClientId("c~a", "hello", null, create)).toBe("fresh-id-0001")
  })
  // 审查 #5：在别的会话里输入同样的文字（如“继续”），不能沿用这个会话放回时的 id
  test("换了会话：即使文字相同也用新的 clientId", () => {
    expect(pickClientId("c~b", "hello", restored, create)).toBe("fresh-id-0001")
  })
})

describe("resolveFailedSend", () => {
  const messages = (...items: Array<Record<string, unknown>>) => async () => ({ messages: items })
  test("明确拒绝：不对账，立即放回", async () => {
    const reconcile = vi.fn()
    expect(await resolveFailedSend({ kind: "rejected", clientId: "c1", reconcile })).toEqual({ action: "restore" })
    expect(reconcile).not.toHaveBeenCalled()
  })
  test("重复提交：不对账，提示已发出过", async () => {
    const reconcile = vi.fn()
    expect(await resolveFailedSend({ kind: "duplicate", clientId: "c1", reconcile })).toEqual({ action: "duplicate" })
    expect(reconcile).not.toHaveBeenCalled()
  })
  test("网络错误：对账发现服务端已有同一 clientId → 已发出，什么都不放回", async () => {
    const outcome = await resolveFailedSend({
      kind: "network",
      clientId: "c1",
      reconcile: messages({ role: "user", clientMessageId: "c1", pending: false }),
    })
    expect(outcome).toEqual({ action: "sent" })
  })
  // 审查 #2：服务端还在准备阶段时存着这条 pending 消息，准备失败会把它删掉
  test("网络错误：同一 clientId 的消息还在 pending → 先等，保留待发箱", async () => {
    const outcome = await resolveFailedSend({
      kind: "network",
      clientId: "c1",
      reconcile: messages({ role: "user", clientMessageId: "c1", pending: true }),
    })
    expect(outcome).toEqual({ action: "wait" })
  })
  // 审查 #1：对账期间输入框已经解锁，对账不能无限挂着
  test("对账长时间没有返回 → 超时按“无法确认”处理", async () => {
    vi.useFakeTimers()
    try {
      const promise = resolveFailedSend({
        kind: "network",
        clientId: "c1",
        reconcile: () => new Promise(() => {}),
        timeoutMs: 5000,
      })
      await vi.advanceTimersByTimeAsync(5001)
      expect(await promise).toEqual({ action: "unknown" })
    } finally {
      vi.useRealTimers()
    }
  })
  test("网络错误：对账确认没有、且没有任务在跑 → 放回", async () => {
    const outcome = await resolveFailedSend({
      kind: "network",
      clientId: "c1",
      reconcile: messages({ role: "user", clientMessageId: "other", pending: false }),
    })
    expect(outcome).toEqual({ action: "restore" })
  })
  test("网络错误：对账确认没有，但有别的任务在跑 → 先等，保留待发箱", async () => {
    const outcome = await resolveFailedSend({
      kind: "network",
      clientId: "c1",
      reconcile: messages({ role: "user", mode: "agent", pending: true, clientMessageId: "other" }),
    })
    expect(outcome).toEqual({ action: "wait" })
  })
  test("网络错误：对账也失败 → 无法确认，保留待发箱", async () => {
    const outcome = await resolveFailedSend({
      kind: "network",
      clientId: "c1",
      reconcile: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    expect(outcome).toEqual({ action: "unknown" })
  })
})

describe("beginSend", () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })
  test("同步写入待发箱并清空草稿：此刻刷新页面也不会丢", () => {
    const result = beginSend({
      sessionName: "c~a",
      text: "hello",
      mode: "agent",
      restored: null,
      createId: () => "fresh-id-0001",
      tabId: "tab-1",
      now: 1000,
      storage,
    }) as { clientId: string }
    expect(result.clientId).toBe("fresh-id-0001")
    const state = loadComposer("c~a", storage)
    expect(state.draft).toBe("")
    expect(state.outbox).toEqual({ clientId: "fresh-id-0001", text: "hello", mode: "agent", createdAt: 1000, tabId: "tab-1" })
  })
  test("原样重发放回的内容：沿用原 clientId", () => {
    const result = beginSend({
      sessionName: "c~a",
      text: "hello",
      mode: "agent",
      restored: { sessionName: "c~a", clientId: "old-id-00001", text: "hello" },
      createId: () => "fresh-id-0001",
      tabId: "tab-1",
      now: 1000,
      storage,
    }) as { clientId: string }
    expect(result.clientId).toBe("old-id-00001")
    expect(loadComposer("c~a", storage).outbox?.clientId).toBe("old-id-00001")
  })
})
