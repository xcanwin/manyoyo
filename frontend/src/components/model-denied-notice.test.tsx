import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ModelDeniedNotice } from "./model-denied-notice"

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

const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(label)) as HTMLButtonElement

async function mount(onRetry = vi.fn()) {
  await act(async () => {
    root.render(<ModelDeniedNotice containerName="box-1" denied={{ host: "api.x.com", prompt: "写个网页" }} onRetry={onRetry} />)
  })
  return onRetry
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("ModelDeniedNotice", () => {
  test("显示被拦的模型地址；允许成功后重发原提示词", async () => {
    apiPost.mockResolvedValue({})
    const onRetry = await mount()
    expect(container.textContent).toContain("模型地址 api.x.com 被网络策略拦截")
    await click(button("允许并重试"))
    expect(apiPost).toHaveBeenCalledWith("/api/containers/box-1/network/allow", { domain: "api.x.com" })
    expect(onRetry).toHaveBeenCalledWith("写个网页")
  })

  test("服务端要求确认：确认后带 confirmRisk 再试一次，才重发", async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error("需要确认"), { status: 400, data: { needsConfirm: true } })).mockResolvedValue({})
    const onRetry = await mount()
    await click(button("允许并重试"))
    expect(onRetry).not.toHaveBeenCalled()
    await click(button("确认放开"))
    expect(apiPost).toHaveBeenLastCalledWith("/api/containers/box-1/network/allow", { domain: "api.x.com", confirmRisk: true })
    expect(onRetry).toHaveBeenCalledWith("写个网页")
  })

  test("允许失败：显示错误，不重发", async () => {
    apiPost.mockRejectedValue(new Error("容器不存在"))
    const onRetry = await mount()
    await click(button("允许并重试"))
    expect(container.textContent).toContain("容器不存在")
    expect(onRetry).not.toHaveBeenCalled()
  })
})
