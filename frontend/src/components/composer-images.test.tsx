import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import type { ComposerImage } from "@/hooks/use-composer-images"
import { Composer } from "./workspace-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = {
  name: "demo", containerName: "demo", agentId: "default", agentName: "AGENT 1", agentRemark: "", containerRemark: "",
  status: "Up", image: "", createdAt: null, updatedAt: null, messageCount: 0, agentEnabled: true, agentProgram: "claude",
  resumeSupported: true, model: "", hostPath: "/w", containerPath: "/w",
} as SessionSummary

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(props: { images?: ComposerImage[]; draft?: string; mode?: "agent" | "command" } = {}) {
  const handlers = { onAddImages: vi.fn(), onRemoveImage: vi.fn(), onSend: vi.fn() }
  await act(async () =>
    root.render(
      <Composer
        draft={props.draft ?? ""}
        onDraftChange={() => {}}
        onSend={handlers.onSend}
        onStop={() => {}}
        mode={props.mode ?? "agent"}
        onModeChange={() => {}}
        disabled={false}
        sending={false}
        session={session}
        onOpenCliTemplate={() => {}}
        onModelChanged={() => {}}
        queueWhen="turn"
        onQueueWhenChange={() => {}}
        images={props.images}
        onAddImages={handlers.onAddImages}
        onRemoveImage={handlers.onRemoveImage}
      />
    )
  )
  return handlers
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const png = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })
const txt = new File(["x"], "a.txt", { type: "text/plain" })

function fireWithFiles(el: Element, type: "paste" | "drop", files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown; dataTransfer?: unknown }
  const data = { files, types: ["Files"] }
  if (type === "paste") event.clipboardData = data
  else event.dataTransfer = data
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

describe("Composer 图片", () => {
  test("粘贴图片：交给 onAddImages 并阻止默认粘贴；非图片不处理", async () => {
    const { onAddImages } = await render()
    const textarea = container.querySelector("textarea")!
    const event = fireWithFiles(textarea, "paste", [png, txt])
    expect(onAddImages).toHaveBeenCalledWith([png])
    expect(event.defaultPrevented).toBe(true)
    onAddImages.mockClear()
    const plain = fireWithFiles(textarea, "paste", [txt])
    expect(onAddImages).not.toHaveBeenCalled()
    expect(plain.defaultPrevented).toBe(false)
  })

  test("拖拽图片到输入框", async () => {
    const { onAddImages } = await render()
    fireWithFiles(container.querySelector("textarea")!, "drop", [png])
    expect(onAddImages).toHaveBeenCalledWith([png])
  })

  test("“添加图片”按钮存在，点它会打开文件选择（accept=image/*，可多选）", async () => {
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe("image/*")
    expect(input.multiple).toBe(true)
    const click = vi.spyOn(input, "click")
    await act(async () => button("添加图片")!.click())
    expect(click).toHaveBeenCalled()
  })

  test("系统命令模式没有图片入口，粘贴也不处理", async () => {
    const { onAddImages } = await render({ mode: "command" })
    expect(button("添加图片")).toBeNull()
    fireWithFiles(container.querySelector("textarea")!, "paste", [png])
    expect(onAddImages).not.toHaveBeenCalled()
  })

  test("缩略图条：可删除；上传中不能发送；只有图片没有文字也能发送", async () => {
    const done: ComposerImage = { id: "i1", src: "blob:1", status: "done", path: "/run/manyoyo/uploads/a.png" }
    const uploading: ComposerImage = { id: "i2", src: "blob:2", status: "uploading" }
    const failed: ComposerImage = { id: "i3", src: "blob:3", status: "error", error: "图片不能超过 10MB" }
    const h = await render({ images: [done, uploading, failed] })
    expect(container.querySelectorAll("[data-composer-images] > div")).toHaveLength(3)
    expect(container.textContent).toContain("图片不能超过 10MB")
    await act(async () => container.querySelectorAll<HTMLButtonElement>('button[aria-label="删除图片"]')[0].click())
    expect(h.onRemoveImage).toHaveBeenCalledWith("i1")
    expect(button("发送")!.disabled).toBe(true)

    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ images: [done] })
    expect(button("发送")!.disabled).toBe(false)
  })
})
