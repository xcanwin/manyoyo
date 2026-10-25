import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { CreateContainerDialog } from "@/components/create-container-dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: { method: string; url: string; body: unknown }[]
let newDefaults: Record<string, unknown>
let runs: Record<string, unknown>
let roots: ReturnType<typeof createRoot>[] = []

beforeEach(() => {
  calls = []
  newDefaults = { containerName: "my-easy-{now}", hostPath: "{quickChatPath}/{now}", containerPath: "{quickChatPath}/{now}", quickChatPath: "/home/u/manyoyo_work" }
  runs = {}
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method: init?.method || "GET", url, body })
      let payload: unknown = {}
      if (url === "/api/config") payload = { parsed: { runs }, defaults: { hostPath: "/srv/serve-cwd", imageName: "img", imageVersion: "1.0.0-common" } }
      else if (url === "/api/system/new-container-defaults") payload = newDefaults
      else if (url === "/api/fs/directories/mkdir") payload = { path: (body as { path: string }).path }
      else if (url === "/api/sessions") payload = { name: "created" }
      return new Response(JSON.stringify(payload), { status: 200 })
    })
  )
})
afterEach(async () => {
  await act(async () => roots.forEach((root) => root.unmount()))
  roots = []
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

async function open() {
  const onCreated = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<CreateContainerDialog open onOpenChange={() => {}} onCreated={onCreated} />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return { onCreated }
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement
async function submit() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === "创建并进入")!
  await act(async () => button.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

describe("新建容器的默认目录", () => {
  test("默认宿主机目录 / 容器内目录是 工作目录根/时间戳，容器名是 my-easy-时间戳；打开时不建目录", async () => {
    await open()
    const match = input("create-host-path").value.match(/^\/home\/u\/manyoyo_work\/(\d{8}-\d{6})$/)
    expect(match).not.toBeNull()
    expect(input("create-container-name").value).toBe(`my-easy-${match![1]}`)
    expect(calls.some((call) => call.url === "/api/fs/directories/mkdir")).toBe(false)
  })

  test("点创建才建目录，再用它创建容器", async () => {
    const { onCreated } = await open()
    const dir = input("create-host-path").value
    await submit()
    const order = calls.filter((call) => call.url === "/api/fs/directories/mkdir" || (call.url === "/api/sessions" && call.method === "POST")).map((call) => call.url)
    expect(order).toEqual(["/api/fs/directories/mkdir", "/api/sessions"])
    const created = calls.find((call) => call.url === "/api/sessions" && call.method === "POST")!.body as { createOptions: Record<string, string> }
    expect(created.createOptions).toMatchObject({ hostPath: dir, containerPath: dir })
    expect(onCreated).toHaveBeenCalledWith("created")
  })

  test("配置里写了固定的容器名和 hostPath：原样用，不建目录", async () => {
    newDefaults = { containerName: "my-fixed", hostPath: "/srv/serve-cwd", containerPath: "", quickChatPath: "/x" }
    await open()
    expect(input("create-host-path").value).toBe("/srv/serve-cwd")
    expect(input("create-container-name").value).toBe("my-fixed")
    await submit()
    expect(calls.some((call) => call.url === "/api/fs/directories/mkdir")).toBe(false)
  })

  test("用户改成自己的目录：不建目录也不动它", async () => {
    await open()
    const field = input("create-host-path")
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(field, "/data/mine")
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await submit()
    expect(calls.some((call) => call.url === "/api/fs/directories/mkdir")).toBe(false)
    const created = calls.find((call) => call.url === "/api/sessions" && call.method === "POST")!.body as { createOptions: Record<string, string> }
    expect(created.createOptions.hostPath).toBe("/data/mine")
  })

  test("选了自带 hostPath 的运行配置：目录留空交给运行配置，不建目录；取消选择后恢复预填", async () => {
    runs = { proj: { hostPath: "~/proj", yolo: "c" } }
    await open()
    const suggested = input("create-host-path").value
    const trigger = document.getElementById("create-run")!
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === "proj")!
    await act(async () => option.click())
    expect(input("create-host-path").value).toBe("")
    // 留空不能是一片空白：提示用的是运行配置里的目录（容器内目录没写就跟宿主机目录一样）
    expect(input("create-host-path").placeholder).toContain("~/proj")
    expect(input("create-container-path").placeholder).toContain("~/proj")
    await submit()
    expect(calls.some((call) => call.url === "/api/fs/directories/mkdir")).toBe(false)
    const created = calls.find((call) => call.url === "/api/sessions" && call.method === "POST")!.body as { run: string; createOptions: Record<string, string> }
    expect(created.run).toBe("proj")
    expect(created.createOptions.hostPath).toBeUndefined()
    expect(suggested).toMatch(/manyoyo_work\/\d{8}-\d{6}$/)
  })
})

describe("新建容器弹窗尺寸", () => {
  test("用 xl 档（字段里有长路径和长选项名）", async () => {
    await open()
    expect(document.querySelector('[data-slot="dialog-content"]')?.getAttribute("data-size")).toBe("xl")
  })
})
