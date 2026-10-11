import { describe, expect, test } from "vitest"

import { syncQuickChatIntoRaw } from "./quick-chat-sync"

const local = `{
    serve: { quickChat: { run: "claude", path: "~/.manyoyo/work/" } },
    imageVersion: "1.0.0-common", // 未保存的修改
}`
const server = `{
    "serve": {"quickChat": {"run": "claude-ds", "path": "/data/work"}},
    "imageVersion": "0.0.1-common"
}`

describe("syncQuickChatIntoRaw", () => {
  test("把服务端已保存的快捷对话设置并入本地未保存的文本，其他未保存的修改不动", () => {
    const out = syncQuickChatIntoRaw(local, server)
    expect(out).toContain('run: "claude-ds"')
    expect(out).toContain('path: "/data/work"')
    expect(out).toContain('imageVersion: "1.0.0-common", // 未保存的修改')
  })
  test("本地文本里没有这两个键：返回 null，由调用方重新加载", () => {
    expect(syncQuickChatIntoRaw('{ imageVersion: "x" }', server)).toBeNull()
  })
  test("服务端没有这两个键：返回 null", () => {
    expect(syncQuickChatIntoRaw(local, "{}")).toBeNull()
  })
})
