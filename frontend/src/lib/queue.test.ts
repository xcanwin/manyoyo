import { beforeEach, describe, expect, test } from "vitest"

import { loadQueueWhen, parseQueue, saveQueueWhen } from "./queue"

describe("queue", () => {
  beforeEach(() => window.localStorage.clear())

  test("发送时机默认“这一轮结束后发送”，记住上次的选择，坏值回到默认", () => {
    expect(loadQueueWhen()).toBe("turn")
    saveQueueWhen("now")
    expect(loadQueueWhen()).toBe("now")
    window.localStorage.setItem("manyoyo:queue-when", "later")
    expect(loadQueueWhen()).toBe("turn")
  })

  test("parseQueue 只保留结构合法的条目", () => {
    expect(parseQueue(undefined)).toBeUndefined()
    expect(
      parseQueue([
        { id: "q-1", clientMessageId: "c-1", text: "a", when: "step", createdAt: "t" },
        { id: "q-2", text: "b", when: "bogus" },
        null,
      ])
    ).toEqual([{ id: "q-1", clientMessageId: "c-1", text: "a", when: "step", createdAt: "t" }])
  })
})
