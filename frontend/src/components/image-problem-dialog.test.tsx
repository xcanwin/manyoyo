import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ImageProblemDialog } from "@/components/image-problem-dialog"
import { apiPost } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("镜像问题弹窗", () => {
  test("接口返回 imageProblem 时弹窗：写明运行时、拉取命令、构建命令和改版本的位置；点知道了关闭", async () => {
    const problem = {
      code: "IMAGE_NOT_FOUND",
      imageRef: "ghcr.io/xcanwin/manyoyo:2.3.1-common",
      runtimeLabel: "MANYOYO 自带的 Podman",
      pullCommand: "my podman pull ghcr.io/xcanwin/manyoyo:2.3.1-common",
      buildCommand: "my build --iv 2.3.1-common",
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "镜像不存在", imageProblem: problem }), { status: 409 })))
    await act(async () => root.render(<ImageProblemDialog />))
    expect(document.body.textContent).not.toContain("本机没有这个镜像")
    let message = ""
    await act(async () => {
      await apiPost("/api/sessions", {}).catch((err) => { message = err.message })
    })
    // 原来那条长提示不再出现（调用方显示的错误文字只剩一句指向弹窗）
    expect(message).toBe("镜像不可用，处理办法见弹窗。")
    expect(message).not.toContain("imageVersion")
    const text = document.body.textContent ?? ""
    expect(text).toContain("本机没有这个镜像")
    expect(text).toContain("MANYOYO 自带的 Podman")
    expect(text).toContain("my podman pull ghcr.io/xcanwin/manyoyo:2.3.1-common")
    expect(text).toContain("my build --iv 2.3.1-common")
    expect(text).toContain("系统设置 → 基础")
    const close = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "知道了")!
    // 关闭过程中标题不能闪成“镜像拉取失败”
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(document.body.textContent ?? ""))
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    await act(async () => close.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    observer.disconnect()
    expect(seen.some((t) => t.includes("镜像拉取失败"))).toBe(false)
    expect(document.body.textContent).not.toContain("本机没有这个镜像")
  })

  test("普通错误不弹", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "别的错误" }), { status: 400 })))
    await act(async () => root.render(<ImageProblemDialog />))
    await act(async () => {
      await apiPost("/api/sessions", {}).catch(() => undefined)
    })
    expect(document.body.textContent).not.toContain("本机没有这个镜像")
  })
})
