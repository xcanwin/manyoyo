import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { clearPathExistsCache } from "@/lib/path-exists"
import { MarkdownContent } from "./markdown-content"

const apiGet = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ apiGet }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  apiGet.mockReset()
  clearPathExistsCache()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderAndClick(onOpenPath: (p: string) => void, content = "试试 `/context` 命令") {
  await act(async () => {
    root.render(<MarkdownContent content={content} sessionName="s1" baseDir="/work" onOpenPath={onOpenPath} />)
  })
  const link = container.querySelector<HTMLElement>("[data-open-path]")!
  await act(async () => {
    link.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("点击路径先判断是否存在", () => {
  test("路径不存在：不调用 onOpenPath", async () => {
    apiGet.mockResolvedValue({ exists: false })
    const open = vi.fn()
    await renderAndClick(open)
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining("/fs/stat?path=%2Fcontext"))
    expect(open).not.toHaveBeenCalled()
  })

  test("路径存在：打开", async () => {
    apiGet.mockResolvedValue({ exists: true, type: "dir" })
    const open = vi.fn()
    await renderAndClick(open)
    expect(open).toHaveBeenCalledWith("/context")
  })

  test("查询失败当作不存在", async () => {
    apiGet.mockRejectedValue(new Error("boom"))
    const open = vi.fn()
    await renderAndClick(open)
    expect(open).not.toHaveBeenCalled()
  })

  test("连点同一路径 5 秒内只查一次", async () => {
    apiGet.mockResolvedValue({ exists: false })
    const open = vi.fn()
    await renderAndClick(open)
    await act(async () => {
      container.querySelector<HTMLElement>("[data-open-path]")!.click()
      await Promise.resolve()
    })
    expect(apiGet).toHaveBeenCalledTimes(1)
  })
})
