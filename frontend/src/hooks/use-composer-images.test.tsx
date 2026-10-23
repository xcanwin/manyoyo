import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useComposerImages } from "@/hooks/use-composer-images"

const uploadChatImage = vi.hoisted(() => vi.fn())
vi.mock("@/lib/chat-images", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/chat-images")>()), uploadChatImage }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const holder: { api: ReturnType<typeof useComposerImages> | null } = { api: null }
const api = new Proxy({} as ReturnType<typeof useComposerImages>, {
  get: (_target, key) => (holder.api as unknown as Record<string | symbol, unknown>)[key],
})
function Probe({ name }: { name: string | null }) {
  const current = useComposerImages(name)
  React.useEffect(() => {
    holder.api = current
  })
  return null
}
const file = (type = "image/png", size = 10) => new File([new Uint8Array(size)], "x", { type })

beforeEach(() => {
  uploadChatImage.mockReset()
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => "blob:x")
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe("useComposerImages", () => {
  test("选中就上传；成功后有路径并存进草稿；删除后同步", async () => {
    uploadChatImage.mockResolvedValue("/run/manyoyo/uploads/a1.png")
    await act(async () => root.render(<Probe name="s1" />))
    await act(async () => api.addFiles([file()]))
    expect(uploadChatImage).toHaveBeenCalledTimes(1)
    expect(api.paths).toEqual(["/run/manyoyo/uploads/a1.png"])
    expect(api.uploading).toBe(false)
    expect(JSON.parse(window.localStorage.getItem("manyoyo:composer-images:s1")!)).toEqual(["/run/manyoyo/uploads/a1.png"])
    await act(async () => api.remove(api.images[0].id))
    expect(window.localStorage.getItem("manyoyo:composer-images:s1")).toBeNull()
  })

  test("不合规的文件不上传，直接标错；上传失败显示原因", async () => {
    uploadChatImage.mockRejectedValue(new Error("这个容器太旧，不支持发图片，重建后可用"))
    await act(async () => root.render(<Probe name="s1" />))
    await act(async () => api.addFiles([file("text/plain"), file("image/png", 11 * 1024 * 1024)]))
    expect(uploadChatImage).not.toHaveBeenCalled()
    expect(api.images.map((item) => item.status)).toEqual(["error", "error"])
    await act(async () => api.addFiles([file()]))
    expect(api.images[2].status).toBe("error")
    expect(api.images[2].error).toContain("太旧")
    expect(api.paths).toEqual([])
  })

  test("最多 5 张：第 6 张直接标错", async () => {
    uploadChatImage.mockImplementation(async () => `/run/manyoyo/uploads/${Math.random().toString(16).slice(2, 10)}.png`)
    await act(async () => root.render(<Probe name="s1" />))
    await act(async () => api.addFiles(Array.from({ length: 6 }, () => file())))
    expect(api.images.filter((item) => item.status === "done")).toHaveLength(5)
    expect(api.images.filter((item) => item.status === "error")).toHaveLength(1)
  })

  test("换会话读回各自草稿里的图片；clear 清空；restore 放回", async () => {
    window.localStorage.setItem("manyoyo:composer-images:s2", JSON.stringify(["/run/manyoyo/uploads/b2.png", "/etc/passwd"]))
    await act(async () => root.render(<Probe name="s1" />))
    expect(api.images).toEqual([])
    await act(async () => root.render(<Probe name="s2" />))
    expect(api.paths).toEqual(["/run/manyoyo/uploads/b2.png"])
    await act(async () => api.clear())
    expect(api.images).toEqual([])
    await act(async () => api.restore(["/run/manyoyo/uploads/b2.png"]))
    expect(api.paths).toEqual(["/run/manyoyo/uploads/b2.png"])
  })
})
