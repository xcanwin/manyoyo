import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { RewindDialog } from "./rewind-dialog"

const apiPost = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), apiPost }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  apiPost.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", role: "user", content: "写个网页", timestamp: "", mode: "agent", snapBefore: "a".repeat(40), ...extra })
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(label)) as HTMLButtonElement
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}
async function mount(msg: ChatMessage, onDone = vi.fn(), onClose = vi.fn()) {
  await act(async () => root.render(<RewindDialog open sessionName="s1" message={msg} onClose={onClose} onDone={onDone} />))
  await flush()
  return { onDone, onClose }
}

const okPreview = { agentProgram: "claude", precise: true, files: { ok: true, total: 3, modify: 1, delete: 1, restore: 1, files: [{ path: "a.txt", action: "modify" }, { path: "b.txt", action: "restore" }, { path: "c.txt", action: "delete" }] } }

describe("RewindDialog", () => {
  test("先预览：显示数量和文件列表；三个选项加一个取消", async () => {
    apiPost.mockResolvedValue(okPreview)
    await mount(message())
    expect(apiPost).toHaveBeenCalledWith("/api/sessions/s1/rewind/preview", { messageId: "m1" })
    expect(document.body.textContent).toContain("将改回 1 个、删除 1 个、恢复 1 个文件")
    expect(document.querySelector("[data-rewind-files]")?.textContent).toContain("c.txt")
    for (const label of ["恢复对话和文件", "只恢复对话", "只恢复文件", "取消"]) expect(button(label)).toBeTruthy()
    expect(button("恢复对话和文件").disabled).toBe(false)
    expect(document.body.textContent).not.toContain("不支持精确回退")
  })

  test("点“恢复对话和文件”：带 scope 调用，成功后交出提示词和图片", async () => {
    apiPost.mockResolvedValueOnce(okPreview).mockResolvedValueOnce({ ok: true, prompt: "写个网页", images: ["/run/manyoyo/uploads/a.png"], filesRestored: true })
    const { onDone } = await mount(message())
    await act(async () => button("恢复对话和文件").click())
    await flush()
    expect(apiPost).toHaveBeenLastCalledWith("/api/sessions/s1/rewind", { messageId: "m1", scope: "both" })
    expect(onDone).toHaveBeenCalledWith({ prompt: "写个网页", images: ["/run/manyoyo/uploads/a.png"], scope: "both", filesRestored: true })
  })

  test("没有文件快照：说明原因，只能选“只恢复对话”", async () => {
    apiPost.mockResolvedValue({ agentProgram: "claude", precise: true, files: null })
    await mount(message({ snapBefore: undefined }))
    expect(document.body.textContent).toContain("这一轮没有文件快照，不能回退文件")
    expect(button("恢复对话和文件").disabled).toBe(true)
    expect(button("只恢复文件").disabled).toBe(true)
    expect(button("只恢复对话").disabled).toBe(false)
  })

  test("目录太大没拍快照：如实说明", async () => {
    apiPost.mockResolvedValue({ agentProgram: "claude", precise: true, files: null })
    await mount(message({ snapBefore: undefined, snapSkipped: "too-large" }))
    expect(document.body.textContent).toContain("目录太大")
  })

  test("不支持精确回退的 agent：如实写“用剩下的聊天记录开新会话”", async () => {
    apiPost.mockResolvedValue({ ...okPreview, agentProgram: "codex", precise: false })
    await mount(message())
    expect(document.body.textContent).toContain("不支持精确回退，对话会用剩下的聊天记录开新会话")
  })

  test("失败：显示错误，不关闭；取消关闭", async () => {
    apiPost.mockResolvedValueOnce(okPreview).mockRejectedValueOnce(new Error("任务进行中，暂时不能回退"))
    const { onDone, onClose } = await mount(message())
    await act(async () => button("只恢复文件").click())
    await flush()
    expect(document.body.textContent).toContain("任务进行中，暂时不能回退")
    expect(onDone).not.toHaveBeenCalled()
    await act(async () => button("取消").click())
    expect(onClose).toHaveBeenCalled()
  })
})
