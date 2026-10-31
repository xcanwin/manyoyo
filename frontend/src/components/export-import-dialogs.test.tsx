import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ExportDialog } from "@/components/export-dialog"
import { ImportDialog } from "@/components/import-dialog"
import { TransferProgressDialog } from "@/components/transfer-progress-dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PREVIEW = {
  tiers: [{ id: "light", label: "轻量" }, { id: "standard", label: "标准", recommended: true }, { id: "full", label: "完整" }],
  items: [
    { id: "history", label: "网页聊天记录", hint: "", tiers: ["light", "standard", "full"] },
    { id: "agentSessions", label: "Agent 会话记录", hint: "", tiers: ["light", "standard", "full"] },
    { id: "uploads", label: "聊天里的图片", hint: "", tiers: ["standard", "full"] },
    { id: "systemLayer", label: "容器里其它改动", hint: "", tiers: ["full"] },
  ],
  estimates: { history: 1000, agentSessions: null, uploads: 2000, systemLayer: null },
  containers: [],
  zstd: true,
  freeBytes: 100 * 1024 * 1024 * 1024,
}
const MANIFEST = {
  format: 1, manyoyoVersion: "8.7.3", createdAt: "2026-10-27T00:00:00Z", items: ["history"], tier: "light", includeSecrets: true, localImage: "img:2",
  containers: [{
    idx: 0, name: "box1", remark: "", image: "img:1", containerPath: "/w", hostPath: "/old", fidelity: "full", work: 0, nameTaken: true,
    suggestedName: "box1-2", suggestedHostPath: "/new/box1-2", imageStatus: "missing", risks: { containerMode: "sock", autostart: true },
  }],
}

let jobView: Record<string, unknown> = {}
let uploadsFail = ""
let xhrStatus = 202
const xhrs: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = []
class FakeXhr {
  upload: { onprogress: ((event: unknown) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ""
  private record = { method: "", url: "", headers: {} as Record<string, string>, body: undefined as unknown }
  open(method: string, url: string) { this.record.method = method; this.record.url = url }
  setRequestHeader(name: string, value: string) { this.record.headers[name] = value }
  send(body: unknown) {
    this.record.body = body
    xhrs.push(this.record)
    this.status = xhrStatus
    this.responseText = xhrStatus === 202 ? JSON.stringify({ jobId: "j3" }) : JSON.stringify({ error: "不是 manyoyo 导出文件" })
    queueMicrotask(() => this.onload?.())
  }
  abort() { this.onabort?.() }
}

let container: HTMLDivElement
let root: Root
const calls: { method: string; url: string; body: unknown }[] = []
beforeEach(() => {
  calls.length = 0
  xhrs.length = 0
  jobView = {}
  uploadsFail = ""
  xhrStatus = 202
  vi.stubGlobal("XMLHttpRequest", FakeXhr)
  window.matchMedia = ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown) as typeof window.matchMedia
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    let body: unknown
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = undefined }
    calls.push({ method, url: String(url), body })
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
    if (String(url).startsWith("/api/transfer/preview")) return reply(PREVIEW)
    if (String(url) === "/api/exports" && method === "POST") return reply({ jobId: "j1", output: "server" })
    if (String(url).startsWith("/api/exports/files/") && method === "DELETE") return reply({ deleted: "x" })
    if (String(url).startsWith("/api/jobs/") && method === "GET") return reply({ job: jobView })
    if (String(url) === "/api/imports/uploads") {
      if (uploadsFail) return new Response(JSON.stringify({ error: uploadsFail }), { status: 409, headers: { "content-type": "application/json" } })
      return reply({ jobId: "j3", uploadUrl: "/api/imports/j3/upload" })
    }
    if (String(url) === "/api/exports") return reply({ dir: "~/.manyoyo/exports", files: [{ name: "manyoyo-export-20261027-000000.tar.zst", size: 1000, mtime: "2026-10-27T00:00:00Z" }], freeBytes: 1 })
    if (String(url) === "/api/imports/inspect") return reply(MANIFEST)
    if (String(url) === "/api/imports") return reply({ jobId: "j2" })
    return reply({})
  }))
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const text = () => document.body.textContent ?? ""
const button = (label: string) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim().startsWith(label))
const press = async (label: string) => {
  const el = button(label)
  expect(el, label).toBeTruthy()
  await act(async () => el!.click())
  await flush()
}
const checkboxOf = (label: string) => {
  const row = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes(label))
  return row?.querySelector("input[type=checkbox]") as HTMLInputElement
}
const tick = async (el: HTMLElement) => { await act(async () => el.click()); await flush() }

describe("导出弹窗", () => {
  const mountExport = async () => {
    await act(async () => root.render(
      <ExportDialog open onOpenChange={() => {}} containers={[{ name: "box1", remark: "", status: "Up 1 hour" }]} initialSelected={["box1"]} onStarted={() => {}} />
    ))
    await flush()
  }

  test("默认推荐的“标准”档；改档位自动勾选；手动改动后变“自定义”，改回来又高亮对应档位", async () => {
    await mountExport()
    expect(checkboxOf("聊天里的图片").checked).toBe(true)
    expect(checkboxOf("容器里其它改动").checked).toBe(false)
    const tierState = (label: string) => button(label)?.getAttribute("aria-pressed")
    expect(tierState("标准")).toBe("true")
    await press("轻量")
    expect(checkboxOf("聊天里的图片").checked).toBe(false)
    expect(tierState("轻量")).toBe("true")
    await tick(checkboxOf("聊天里的图片"))
    expect(tierState("标准")).toBe("true")
    await tick(checkboxOf("Agent 会话记录"))
    expect(tierState("自定义")).toBe("true")
    expect(tierState("标准")).toBe("false")
    await tick(checkboxOf("Agent 会话记录"))
    expect(tierState("标准")).toBe("true")
  })

  test("密钥默认带上并提醒；开始导出发出选中的内容；大小未知时说明", async () => {
    await mountExport()
    expect(text()).toContain("文件里有你的 API Key")
    expect(text()).toContain("大小未知")
    await press("保存到服务器")
    await press("开始导出")
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/exports")
    expect(post?.body).toMatchObject({ containers: ["box1"], items: ["history", "agentSessions", "uploads"], includeSecrets: true, compression: "fast", output: "server" })
    expect(post?.body).not.toHaveProperty("estimate")
  })

  test("侧栏里正在导出 / 导入的容器（摘要带 job）打开弹窗就标成忙碌：不勾选、不能勾，开始导出不带它", async () => {
    const starts: unknown[] = []
    await act(async () => root.render(
      <ExportDialog open onOpenChange={() => {}} containers={[{ name: "box1", remark: "", status: "busy" }, { name: "box2", remark: "", status: "Up 1 hour" }]} initialSelected={["box1", "box2"]} onStarted={(info) => starts.push(info)} />
    ))
    await flush()
    expect(checkboxOf("box1").checked).toBe(false)
    expect(checkboxOf("box1").disabled).toBe(true)
    expect(text()).toContain("正在导出 / 导入")
    await press("保存到服务器")
    await press("开始导出")
    const sent = calls.find((c) => c.method === "POST" && c.url === "/api/exports")
    expect((sent?.body as { containers: string[] }).containers).toEqual(["box2"])
  })

  test("暂停的容器显示“已暂停”，docker 与 podman 的写法都认", async () => {
    await act(async () => root.render(
      <ExportDialog open onOpenChange={() => {}} containers={[
        { name: "a", remark: "", status: "Up 3 hours (Paused)" },
        { name: "b", remark: "", status: "Paused" },
        { name: "c", remark: "", status: "Up 1 hour" },
      ]} initialSelected={["a"]} onStarted={() => {}} />
    ))
    await flush()
    const badges = [...document.querySelectorAll("label")].map((l) => l.textContent ?? "")
    expect(badges.filter((t) => t.includes("已暂停")).length).toBe(2)
    expect(badges.filter((t) => t.includes("运行中")).length).toBe(1)
  })

  test("说明文字如实：不带密钥、直接下载、更小", async () => {
    await mountExport()
    await tick(document.getElementById("export-secrets") as HTMLElement)
    expect(text()).toContain("API Key、令牌、密码类变量和登录凭据都会去掉；工作目录里的文件原样带上")
    expect(text()).toContain("浏览器直接接收，服务器不留文件")
    expect(text()).not.toContain("服务器不占磁盘")
    await press("更小")
    expect(text()).toContain("通常更小、更慢")
  })

  test("服务器剩余空间不够时，保存到服务器的“开始导出”禁用并说明原因", async () => {
    PREVIEW.freeBytes = 10 * 1024 * 1024
    try {
      await mountExport()
      await press("保存到服务器")
      expect((button("开始导出") as HTMLButtonElement).disabled).toBe(true)
      expect(text()).toContain("剩余空间")
    } finally {
      PREVIEW.freeBytes = 100 * 1024 * 1024 * 1024
    }
  })
})

describe("导入弹窗", () => {
  const mountImport = async (onStarted: (jobId: string) => void = () => {}) => {
    await act(async () => root.render(<ImportDialog open onOpenChange={() => {}} onStarted={onStarted} />))
    await flush()
  }
  const pickServerFile = async () => {
    await press("服务器上的文件")
    await press("manyoyo-export-20261027-000000.tar.zst")
  }
  const setInput = async (id: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(document.getElementById(id), value)
      document.getElementById(id)!.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  test("选服务器上的文件 → 先看清单（自动换名、风险项默认不勾）→ 不勾风险直接导入，confirm 全是空", async () => {
    const started: string[] = []
    await mountImport((jobId) => started.push(jobId))
    await pickServerFile()
    expect((document.getElementById("imp-name-0") as HTMLInputElement).value).toBe("box1-2")
    expect(text()).toContain("本机已有同名容器")
    expect(text()).toContain("sock 模式")
    expect(text()).toContain("自启动脚本")
    expect(checkboxOf("sock 模式").checked).toBe(false)

    await setInput("imp-remark-0", "改后的备注")
    await tick(checkboxOf("自启动脚本"))
    await press("开始导入")
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/imports")
    expect(post?.body).toEqual({
      serverFile: "manyoyo-export-20261027-000000.tar.zst",
      plan: { containers: { 0: { name: "box1-2", remark: "改后的备注", hostPath: "/new/box1-2", imageMode: "same", confirm: { volumes: [], ports: false, autostart: true, envFiles: [], networkOpen: false } } } },
    })
    expect(started).toEqual(["j2"])
  })

  test("本机没有原镜像时，容器卡片上就写明会用默认版本", async () => {
    await mountImport()
    await pickServerFile()
    expect(text()).toContain("本机没有原镜像，将用默认版本，系统层改动不会还原")
  })

  test("备注最多 200 字并显示字数", async () => {
    await mountImport()
    await pickServerFile()
    expect((document.getElementById("imp-remark-0") as HTMLInputElement).maxLength).toBe(200)
    await setInput("imp-remark-0", "12345678")
    expect(text()).toContain("8/200")
  })

  test("本机文件分两步：先登记（JSON），再把文件 POST 到 uploadUrl", async () => {
    const started: string[] = []
    await mountImport((jobId) => started.push(jobId))
    const file = new File(["abc"], "x.tar.zst")
    const input = document.getElementById("imp-file") as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true })
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
    await press("开始导入")
    const order = calls.map((c) => c.url)
    expect(order.indexOf("/api/imports/uploads")).toBeGreaterThan(-1)
    expect(calls.find((c) => c.url === "/api/imports/uploads")?.body).toHaveProperty("plan")
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/imports")).toBe(false)
    expect(xhrs).toHaveLength(1)
    expect(xhrs[0].url).toBe("/api/imports/j3/upload")
    expect(xhrs[0].headers["Content-Type"]).toBe("application/octet-stream")
    expect(xhrs[0].body).toBe(file)
    expect(started).toEqual(["j3"])
  })

  test("上传没成功时把已登记的任务取消（不然 2 分钟内换文件重试会被“已经有一个导入在进行”挡住）", async () => {
    xhrStatus = 400
    await mountImport()
    const input = document.getElementById("imp-file") as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, "files", { value: [new File(["abc"], "x.tar.zst")], configurable: true })
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
    await press("开始导入")
    expect(text()).toContain("不是 manyoyo 导出文件")
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/jobs/j3/cancel")).toBe(true)
  })

  test("登记失败（如工作目录已存在）直接显示服务端的话，不上传", async () => {
    uploadsFail = "工作目录已存在且不为空"
    await mountImport()
    const input = document.getElementById("imp-file") as HTMLInputElement
    await act(async () => {
      Object.defineProperty(input, "files", { value: [new File(["abc"], "x.tar.zst")], configurable: true })
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
    await press("开始导入")
    expect(text()).toContain("工作目录已存在且不为空")
    expect(xhrs).toHaveLength(0)
  })

  test("服务器文件：列出名字、大小、时间；删除要二次确认，确认后刷新列表", async () => {
    await mountImport()
    await press("服务器上的文件")
    expect(text()).toContain("manyoyo-export-20261027-000000.tar.zst")
    expect(text()).toContain("1000 B")
    const download = document.querySelector<HTMLAnchorElement>("a[aria-label^='下载']")
    expect(download?.getAttribute("href")).toBe("/api/exports/files/manyoyo-export-20261027-000000.tar.zst")
    const listCalls = () => calls.filter((c) => c.method === "GET" && c.url === "/api/exports").length
    const before = listCalls()
    await act(async () => document.querySelector<HTMLElement>("button[aria-label^='删除']")!.click())
    await flush()
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    expect(text()).toContain("删除后无法恢复")
    await press("删除")
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/exports/files/manyoyo-export-20261027-000000.tar.zst")
    expect(listCalls()).toBe(before + 1)
  })
})

describe("进度弹窗", () => {
  const baseJob = {
    id: "j1", type: "export", status: "running", containers: ["box1"], stage: "读取容器", container: "box1", bytes: 2048, estimate: 4096,
    estimateComplete: true, error: "", result: null, cancelRequested: false, output: "download", downloadUrl: "", uploadUrl: "", warnings: [],
  }
  const mountProgress = async (onFinished: () => void = () => {}) => {
    await act(async () => root.render(<TransferProgressDialog jobId="j1" onClose={() => {}} onFinished={onFinished} />))
    await flush()
  }

  test("估算不完整时不显示百分比和“约 X”", async () => {
    jobView = { ...baseJob, estimateComplete: false }
    await mountProgress()
    expect(text()).toContain("已处理 2.0 KB")
    expect(text()).not.toContain("%")
    expect(text()).not.toContain("约")
  })

  test("估算完整时显示百分比", async () => {
    jobView = { ...baseJob }
    await mountProgress()
    expect(text()).toContain("50%")
  })

  test("准备中有取消按钮；ready 时始终有“下载”按钮", async () => {
    jobView = { ...baseJob, status: "preparing" }
    await mountProgress()
    expect(text()).toContain("正在准备")
    expect(button("取消导出")).toBeTruthy()
    jobView = { ...baseJob, status: "ready", downloadUrl: "/api/exports/j1/download" }
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)) })
    expect(button("准备好了，点这里下载")).toBeTruthy()
  })

  test("onFinished 是每次渲染都变的内联函数也不会让完成提示重复弹出", async () => {
    jobView = { ...baseJob, status: "done", result: { file: "a.tar.zst" } }
    const calls2: number[] = []
    const render = (n: number) => root.render(<TransferProgressDialog jobId="j1" onClose={() => {}} onFinished={() => { calls2.push(n) }} />)
    await act(async () => render(1))
    await flush()
    await act(async () => render(2))
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)) })
    await act(async () => render(3))
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)) })
    expect(calls2.length).toBe(1)
  })

  test("导入的进度弹窗不再写“下载”", async () => {
    jobView = { ...baseJob, type: "import", status: "running", containers: ["dst"] }
    await mountProgress()
    expect(text()).toContain("导入期间")
    expect(text()).not.toContain("下载")
  })

  test("下载被打断时如实说明需要重新导出", async () => {
    jobView = { ...baseJob, status: "cancelled", error: "连接中断，已取消" }
    await mountProgress()
    expect(text()).toContain("下载中断了，需要重新导出（下载不能续传）")
  })

  test("导出结束带警告时显示出来", async () => {
    jobView = { ...baseJob, status: "done", output: "server", result: { file: "x.tar.zst", warnings: ["容器 box1 没能暂停，导出的是运行中的状态"] } }
    await mountProgress()
    expect(text()).toContain("容器 box1 没能暂停")
  })

  test("导入有丢弃项时逐条列出，不只说“已导入”", async () => {
    jobView = {
      ...baseJob, type: "import", status: "done", output: "", result: {
        containers: ["box1-2"],
        details: [{ name: "box1-2", oldName: "box1", dropped: ["挂载 /a:/b 未确认，没有还原"], layerSkippedSystem: 3 }],
      },
    }
    await mountProgress()
    expect(text()).toContain("box1-2：挂载 /a:/b 未确认，没有还原")
    expect(text()).toContain("box1-2：用了默认镜像，3 个系统层文件没有还原")
  })

  test("连续读取失败 3 次才提示连不上，且不显示原始报错", async () => {
    vi.useFakeTimers()
    try {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new TypeError("Failed to fetch") })
      await act(async () => root.render(<TransferProgressDialog jobId="j1" onClose={() => {}} onFinished={() => {}} />))
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      expect(text()).not.toContain("连不上服务器")
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
      expect(text()).toContain("连不上服务器，任务可能仍在进行")
      expect(text()).not.toContain("Failed to fetch")
    } finally {
      vi.useRealTimers()
    }
  })
})
