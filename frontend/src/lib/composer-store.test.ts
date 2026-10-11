import { beforeEach, describe, expect, test } from "vitest"

import {
  clearAllComposerData,
  clearOutbox,
  createClientMessageId,
  decideOutboxRestore,
  loadComposer,
  planRestore,
  purgeExpiredComposerData,
  saveDraft,
  setOutbox,
  type Outbox,
  type StorageLike,
} from "./composer-store"

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

function throwingStorage(): StorageLike {
  const boom = () => {
    throw new Error("denied")
  }
  return { getItem: boom, setItem: boom, removeItem: boom, key: boom, length: 0 }
}

const outbox = (extra: Partial<Outbox> = {}): Outbox => ({
  clientId: "cid-12345678",
  text: "写一个排序",
  mode: "agent",
  createdAt: 1_000_000,
  tabId: "tab-a",
  ...extra,
})

let storage: ReturnType<typeof memoryStorage>
beforeEach(() => {
  storage = memoryStorage()
})

describe("草稿", () => {
  test("保存后能按会话读回，不同会话互不影响", () => {
    saveDraft("c1~a", "你好", storage)
    saveDraft("c1~b", "另一个", storage)
    expect(loadComposer("c1~a", storage).draft).toBe("你好")
    expect(loadComposer("c1~b", storage).draft).toBe("另一个")
    expect(loadComposer("c2~a", storage)).toEqual({ draft: "" })
  })
  test("草稿清空且没有待发箱：删除这个键", () => {
    saveDraft("s", "x", storage)
    expect(storage.data.size).toBe(1)
    saveDraft("s", "", storage)
    expect(storage.data.size).toBe(0)
  })
  test("坏数据当作没有", () => {
    storage.setItem("manyoyo:composer:s", "{not json")
    expect(loadComposer("s", storage)).toEqual({ draft: "" })
  })
})

describe("待发箱", () => {
  test("写入待发箱时同步清空草稿", () => {
    saveDraft("s", "写一个排序", storage)
    setOutbox("s", outbox(), storage)
    const state = loadComposer("s", storage)
    expect(state.draft).toBe("")
    expect(state.outbox?.clientId).toBe("cid-12345678")
  })
  test("按 clientId 清除；id 不匹配不清除", () => {
    setOutbox("s", outbox(), storage)
    clearOutbox("s", "other-id-1234", storage)
    expect(loadComposer("s", storage).outbox).toBeDefined()
    clearOutbox("s", "cid-12345678", storage)
    expect(loadComposer("s", storage).outbox).toBeUndefined()
  })
  test("清除待发箱时保留草稿", () => {
    setOutbox("s", outbox(), storage)
    saveDraft("s", "新的草稿", storage)
    clearOutbox("s", undefined, storage)
    expect(loadComposer("s", storage)).toEqual({ draft: "新的草稿" })
  })
  test("clientMessageId 格式符合服务端约定", () => {
    for (let i = 0; i < 20; i++) expect(createClientMessageId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(createClientMessageId()).not.toBe(createClientMessageId())
  })
})

describe("decideOutboxRestore", () => {
  const base = { now: 1_000_000 + 60_000, currentTabId: "tab-a", sessionRunning: false }
  test("消息里已有同一个 clientId：说明已发出，清掉", () => {
    expect(decideOutboxRestore({ ...base, outbox: outbox(), messages: [{ clientMessageId: "cid-12345678" }] })).toBe("clear")
  })
  // 审查 #2：对账看到它时服务端还在准备阶段，准备失败会把这条消息删掉——还在 pending 就不能清待发箱
  test("已有同一个 clientId 但还在 pending：先等，不清待发箱", () => {
    expect(
      decideOutboxRestore({ ...base, outbox: outbox(), messages: [{ clientMessageId: "cid-12345678", pending: true }] })
    ).toBe("wait")
  })
  test("找不到且没有任务在跑：放回", () => {
    expect(decideOutboxRestore({ ...base, outbox: outbox(), messages: [{ clientMessageId: "x" }] })).toBe("restore")
  })
  test("找不到但任务在跑：先等（可能正在发送）", () => {
    expect(decideOutboxRestore({ ...base, outbox: outbox(), messages: [], sessionRunning: true })).toBe("wait")
  })
  test("别的标签页写的、不到 10 秒：先等", () => {
    expect(
      decideOutboxRestore({ ...base, now: 1_000_000 + 9_000, outbox: outbox({ tabId: "tab-b" }), messages: [] })
    ).toBe("wait")
  })
  test("别的标签页写的、超过 10 秒：放回", () => {
    expect(
      decideOutboxRestore({ ...base, now: 1_000_000 + 11_000, outbox: outbox({ tabId: "tab-b" }), messages: [] })
    ).toBe("restore")
  })
  test("本标签页写的不受 10 秒限制（刷新后 tabId 不变）", () => {
    expect(decideOutboxRestore({ ...base, now: 1_000_000 + 1_000, outbox: outbox(), messages: [] })).toBe("restore")
  })
  test("没有待发箱：none", () => {
    expect(decideOutboxRestore({ ...base, outbox: undefined, messages: [] })).toBe("none")
  })
})

describe("planRestore", () => {
  test("输入框为空：直接填进去", () => {
    expect(planRestore("", outbox())).toEqual({ kind: "fill", text: "写一个排序" })
    expect(planRestore("  \n", outbox())).toEqual({ kind: "fill", text: "写一个排序" })
  })
  test("输入框不为空：不覆盖，改为提示 + 恢复按钮", () => {
    expect(planRestore("我正在写别的", outbox())).toEqual({ kind: "banner" })
  })
})

describe("清理与降级", () => {
  test("登出清空所有 composer 键，不动别的键", () => {
    saveDraft("a", "1", storage)
    setOutbox("b", outbox(), storage)
    storage.setItem("other", "keep")
    expect(storage.data.size).toBe(3)
    clearAllComposerData(storage)
    expect(Array.from(storage.data.keys())).toEqual(["other"])
  })
  test("超过 30 天的条目启动时清理", () => {
    const now = 100 * 24 * 3600 * 1000
    storage.setItem("manyoyo:composer:old", JSON.stringify({ draft: "x", updatedAt: now - 31 * 24 * 3600 * 1000 }))
    storage.setItem("manyoyo:composer:new", JSON.stringify({ draft: "y", updatedAt: now - 1000 }))
    purgeExpiredComposerData(now, storage)
    expect(Array.from(storage.data.keys())).toEqual(["manyoyo:composer:new"])
  })
  test("localStorage 抛错时静默降级", () => {
    const bad = throwingStorage()
    expect(() => saveDraft("s", "x", bad)).not.toThrow()
    expect(() => setOutbox("s", outbox(), bad)).not.toThrow()
    expect(() => clearOutbox("s", undefined, bad)).not.toThrow()
    expect(() => clearAllComposerData(bad)).not.toThrow()
    expect(() => purgeExpiredComposerData(1, bad)).not.toThrow()
    expect(loadComposer("s", bad)).toEqual({ draft: "" })
  })
})
