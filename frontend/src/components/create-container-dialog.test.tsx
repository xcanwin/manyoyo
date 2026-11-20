import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { CreateContainerDialog } from "@/components/create-container-dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let calls: { method: string; url: string; body: unknown }[]
let newDefaults: Record<string, unknown>
let runs: Record<string, unknown>
let presets: Record<string, Record<string, unknown>>
let inferResult: Record<string, unknown>
let inferFails: boolean
let globalPresetGate: Promise<void> | null
let runPresetGate: Promise<void> | null
let roots: ReturnType<typeof createRoot>[] = []

const emptyPreset = (run = "") => ({
  run,
  autostart: "",
  autostartOnServe: false,
  network: { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false },
})

beforeEach(() => {
  calls = []
  newDefaults = { containerName: "my-easy-{now}", hostPath: "{quickChatPath}/{now}", containerPath: "{quickChatPath}/{now}", quickChatPath: "/home/u/manyoyo_work" }
  runs = {}
  presets = {}
  inferResult = { candidates: [], truncated: false, preset: "restricted" }
  inferFails = false
  globalPresetGate = null
  runPresetGate = null
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method: init?.method || "GET", url, body })
      let payload: unknown = {}
      if (url === "/api/config") payload = { parsed: { runs }, defaults: { hostPath: "/srv/serve-cwd", imageName: "img", imageVersion: "1.0.0-common" } }
      else if (url === "/api/system/new-container-defaults") payload = newDefaults
      else if (url === "/api/system/new-container-preset") {
        if (globalPresetGate) await globalPresetGate
        payload = presets[""] || emptyPreset()
      } else if (url.startsWith("/api/system/new-container-preset?")) {
        if (runPresetGate) await runPresetGate
        const run = decodeURIComponent(new URL(url, "http://localhost").searchParams.get("run") || "")
        payload = presets[run] || emptyPreset(run)
      } else if (url === "/api/system/new-container-preset/infer") {
        if (inferFails) return new Response(JSON.stringify({ error: "识别失败" }), { status: 500 })
        payload = inferResult
      } else if (url === "/api/fs/directories/mkdir") payload = { path: (body as { path: string }).path }
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

async function selectRun(name: string) {
  const trigger = document.getElementById("create-run")!
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === name)!
  await act(async () => option.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

const createdOptions = () => {
  const created = calls.find((call) => call.url === "/api/sessions" && call.method === "POST")!.body as { createOptions: Record<string, unknown> }
  return created.createOptions
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

describe("运行配置预设带入", () => {
  const projectPreset = {
    run: "proj",
    autostart: "echo boot\n",
    autostartOnServe: true,
    network: { version: 2, preset: "allowlist", outbound: [{ action: "allow", target: "corp.example.com", ports: "443", proto: "tcp", enabled: true }], inbound: [], expose: [], autostartOnServe: true },
  }

  test("选运行配置后回填自启动 / autostartOnServe / 网络，有内容自动展开", async () => {
    runs = { proj: { yolo: "c" } }
    presets.proj = projectPreset
    await open()
    await selectRun("proj")
    const textarea = document.getElementById("create-autostart") as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea!.value).toBe("echo boot\n")
    expect((document.getElementById("create-autostart-serve") as HTMLInputElement).checked).toBe(true)
    expect(document.body.textContent).toContain("仅白名单")
    expect(Array.from(document.querySelectorAll<HTMLInputElement>("input")).map((item) => item.value)).toContain("corp.example.com")
  })

  test("没改预设时提交不带 autostart / autostartOnServe / network", async () => {
    runs = { proj: { yolo: "c" } }
    presets.proj = projectPreset
    await open()
    await selectRun("proj")
    await submit()
    const options = createdOptions()
    expect(options).not.toHaveProperty("autostart")
    expect(options).not.toHaveProperty("autostartOnServe")
    expect(options).not.toHaveProperty("network")
    // 弹窗自己管理候选勾选，服务端不要再自动加
    expect(options.autoAllowScriptEndpoints).toBe(false)
  })

  test("清空自启动、关掉 serve 拉起、把网络改回默认，都显式发送", async () => {
    runs = { proj: { yolo: "c" } }
    presets.proj = projectPreset
    await open()
    await selectRun("proj")
    const textarea = document.getElementById("create-autostart") as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(textarea, "")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => document.getElementById("create-autostart-serve")!.click())
    const tighten = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === "收紧（默认）")!
    await act(async () => tighten.click())
    await submit()
    const options = createdOptions()
    expect(options.autostart).toBe("")
    expect(options.autostartOnServe).toBe(false)
    expect((options.network as { preset: string }).preset).toBe("restricted")
  })

  test("候选默认勾选普通项、风险项不勾；提交时合并进出站允许规则", async () => {
    runs = { proj: { yolo: "c" } }
    presets.proj = { ...projectPreset, autostart: "", autostartOnServe: false, network: { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false } }
    inferResult = {
      candidates: [
        { id: "cidr|10.2.3.4|", kind: "cidr", target: "10.2.3.4", ports: "", proto: "all", sources: ["autostart"], evidence: "10.2.3.4", resolved: [], risk: "private", defaultChecked: true },
        { id: "cidr|169.254.169.254|", kind: "cidr", target: "169.254.169.254", ports: "", proto: "all", sources: ["autostart"], evidence: "169.254.169.254", resolved: [], risk: "metadata", defaultChecked: false },
      ],
      truncated: false,
      preset: "restricted",
    }
    await open()
    await selectRun("proj")
    expect(document.body.textContent).toContain("检测到 2 个可能需要放行的地址")
    expect(document.body.textContent).toContain("云元数据")
    await submit()
    const outbound = (createdOptions().network as { outbound: Array<{ target: string }> }).outbound
    expect(outbound.map((rule) => rule.target)).toEqual(["10.2.3.4"])
  })

  test("识别失败只提示，不阻塞创建；切换运行配置会清掉旧候选与旧自启动", async () => {
    runs = { proj: { yolo: "c" }, plain: { yolo: "c" } }
    presets.proj = projectPreset
    presets.plain = emptyPreset("plain")
    inferFails = true
    await open()
    await selectRun("proj")
    expect(document.body.textContent).toContain("识别失败")
    await submit()
    expect(calls.some((call) => call.url === "/api/sessions" && call.method === "POST")).toBe(true)
    expect(createdOptions()).not.toHaveProperty("autostart")

    inferFails = false
    inferResult = { candidates: [], truncated: false, preset: "restricted" }
    await act(async () => {
      const field = document.getElementById("create-run")!
      field.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === "plain")!
    await act(async () => option.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const autostartToggle = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("自启动命令"))!
    await act(async () => autostartToggle.click())
    expect((document.getElementById("create-autostart") as HTMLTextAreaElement).value).toBe("")
    expect(document.body.textContent).not.toContain("检测到 2 个可能需要放行的地址")
  })
})

describe("预设加载竞态", () => {
  test("初始默认值晚返回时不会覆盖已经选好的运行配置预设", async () => {
    runs = { qa: { yolo: "c" } }
    presets[""] = { run: "", autostart: "GLOBAL-BOOT\n", autostartOnServe: false, network: { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false } }
    presets.qa = { run: "qa", autostart: "RUN-BOOT\n", autostartOnServe: false, network: { version: 2, preset: "allowlist", outbound: [{ action: "allow", target: "corp.example.com", ports: "443", proto: "tcp", enabled: true }], inbound: [], expose: [], autostartOnServe: false } }
    let releaseGlobal = () => {}
    globalPresetGate = new Promise<void>((resolve) => { releaseGlobal = resolve })
    await open()
    await selectRun("qa")
    expect((document.getElementById("create-autostart") as HTMLTextAreaElement).value).toBe("RUN-BOOT\n")
    // 全局预设此时才返回，不能覆盖 run 的自启动 / 网络
    await act(async () => releaseGlobal())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect((document.getElementById("create-autostart") as HTMLTextAreaElement).value).toBe("RUN-BOOT\n")
    expect(document.body.textContent).toContain("仅白名单")
    await submit()
    expect(JSON.stringify(calls.find((call) => call.url === "/api/sessions" && call.method === "POST")!.body)).not.toContain("GLOBAL-BOOT")
  })

  test("运行配置预设加载期间禁用提交，加载完恢复", async () => {
    runs = { qa: { yolo: "c" } }
    presets.qa = { run: "qa", autostart: "RUN-BOOT\n", autostartOnServe: false, network: { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false } }
    let releaseRun = () => {}
    await open()
    runPresetGate = new Promise<void>((resolve) => { releaseRun = resolve })
    await selectRun("qa")
    const submitButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes("创建并进入") || item.textContent?.includes("读取预设中"))!
    expect(submitButton().disabled).toBe(true)
    await act(async () => releaseRun())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(submitButton().disabled).toBe(false)
  })
})
