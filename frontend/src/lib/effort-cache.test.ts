import { describe, expect, test } from "vitest"

import { loadEffortCache, saveEffortCache } from "@/lib/effort-cache"

function memory() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}

describe("推理强度选项缓存", () => {
  test("存取；没有 / 坏数据 / 没有存储都当没有", () => {
    const storage = memory()
    expect(loadEffortCache("a", storage)).toBeNull()
    saveEffortCache("a", { levels: ["low"], envDefault: "max" }, storage)
    expect(loadEffortCache("a", storage)).toEqual({ levels: ["low"], envDefault: "max" })
    storage.setItem("manyoyo:effort-levels", "{bad")
    expect(loadEffortCache("a", storage)).toBeNull()
    storage.setItem("manyoyo:effort-levels", JSON.stringify({ a: { levels: [1] } }))
    expect(loadEffortCache("a", storage)).toBeNull()
    expect(loadEffortCache("a", null)).toBeNull()
    expect(() => saveEffortCache("a", { levels: [], envDefault: "" }, null)).not.toThrow()
  })
  test("最多留 50 条，旧的先丢", () => {
    const storage = memory()
    for (let i = 0; i < 60; i += 1) saveEffortCache(`k${i}`, { levels: ["low"], envDefault: "" }, storage)
    expect(loadEffortCache("k0", storage)).toBeNull()
    expect(loadEffortCache("k59", storage)).not.toBeNull()
    expect(Object.keys(JSON.parse(storage.getItem("manyoyo:effort-levels")!)).length).toBe(50)
  })
})
