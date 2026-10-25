import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SystemSettingsDialog } from "./system-settings-dialog"
import { ThemeProvider } from "./theme-provider"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 这些面板自己的行为不在本文件范围：换成空组件；快捷对话的设置弹窗里是 base-ui 的下拉，
// 换成一个“选 claude-ds 并保存”的按钮，保存走真实的接口调用并回调 onSaved
vi.mock("@/components/capacity-estimate-view", () => ({ CapacityEstimateView: () => null }))
vi.mock("@/components/doctor-panel", () => ({ DoctorPanel: () => null }))
vi.mock("@/components/orphan-states-panel", () => ({ OrphanStatesPanel: () => null }))
vi.mock("@/components/code-mirror-editor", () => ({
  CodeMirrorEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="json-editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}))
vi.mock("@/components/quick-chat-setup-dialog", async () => {
  const { apiPut } = await import("@/lib/api")
  return {
    QuickChatSetupDialog: ({ open, onSaved }: { open: boolean; onSaved: (path: string, run: string) => void }) =>
      open ? (
        <button
          type="button"
          data-testid="quick-chat-save-ds"
          onClick={async () => {
            await apiPut("/api/system/quick-chat-config", { path: "~/.manyoyo/work/", run: "claude-ds" })
            onSaved("~/.manyoyo/work/", "claude-ds")
          }}
        >
          选 claude-ds 并保存
        </button>
      ) : null,
  }
})

// 假版本号：内容的简单哈希（真实服务端用 sha256，这里只需要“内容不同版本不同”）
const sha = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `v${text.length}-${h}`
}
declare const process: { env: Record<string, string | undefined> }

// 假的服务端：配置文件是一段文本；接口语义与 lib/web/server.js 一致（GET 带 etag；PUT 必须带 If-Match，428 / 409 / 200）
class FakeServer {
  raw: string
  mirrors = { apt: "", npm: "", pip: "" }
  puts: Array<{ raw: string; ifMatch: string | null }> = []
  // 非空时，PUT /api/config 先等它（模拟保存请求还在路上）
  putGate: Promise<void> | null = null
  constructor(raw: string) {
    this.raw = raw
  }
  snapshot() {
    // 磁盘上的配置被写坏时，真实服务端返回 raw: ""（无法安全显示），版本号仍是磁盘原文的
    const broken = this.raw.startsWith("BROKEN")
    return { path: "/home/u/.manyoyo/manyoyo.json", raw: broken ? "" : this.raw, etag: sha(this.raw), editable: !broken, parseError: broken ? "bad" : null, parsed: {}, defaults: {}, notice: "" }
  }
  // 模拟 CLI / 另一个标签页直接改文件
  external(from: string, to: string) {
    this.raw = this.raw.replace(from, to)
  }
  // 在最外层对象末尾加一个键（原文末尾可能已经有尾逗号）
  insertTopLevel(text: string) {
    return this.raw.replace(/,?\s*\}\s*$/, `,\n    ${text},\n}`)
  }
  setQuickChat(run: string) {
    if (/quickChat/.test(this.raw)) this.raw = this.raw.replace(/(quickChat:\s*\{\s*run:\s*)"[^"]*"/, `$1"${run}"`)
    else this.raw = this.insertTopLevel(`serve: { quickChat: { run: "${run}", path: "~/.manyoyo/work/" } }`)
  }
  setMirrors(m: { apt: string; npm: string; pip: string }) {
    this.mirrors = m
    const text = `mirrors: { apt: "${m.apt}", npm: "${m.npm}", pip: "${m.pip}" }`
    if (/mirrors:/.test(this.raw)) this.raw = this.raw.replace(/mirrors:\s*\{[^}]*\}/, text)
    else this.raw = this.insertTopLevel(text)
  }
  handle(url: string, init: RequestInit = {}): { status: number; body: unknown } {
    const method = (init.method || "GET").toUpperCase()
    const headers = new Headers(init.headers)
    const body = init.body ? JSON.parse(String(init.body)) : {}
    if (url === "/api/config" && method === "GET") return { status: 200, body: this.snapshot() }
    if (url === "/api/config" && method === "PUT") {
      const ifMatch = headers.get("If-Match")
      this.puts.push({ raw: body.raw, ifMatch })
      // FAKE_SERVER_LEGACY=1：模拟改版前的服务端（不带版本也直接覆盖），用来在旧前端上复现原始问题
      if (process.env.FAKE_SERVER_LEGACY === "1" && ifMatch === null) {
        this.raw = body.raw
        return { status: 200, body: { saved: true } }
      }
      if (ifMatch === null) return { status: 428, body: { error: "需要 If-Match" } }
      if (ifMatch !== sha(this.raw)) return { status: 409, body: { error: "配置文件已被其他地方修改", conflict: true, ...this.snapshot() } }
      this.raw = body.raw
      return { status: 200, body: { saved: true, etag: sha(this.raw) } }
    }
    if (url === "/api/system/quick-chat-config" && method === "GET") return { status: 200, body: { path: "~/.manyoyo/work/", run: /run:\s*"([^"]*)"/.exec(this.raw)?.[1] ?? null } }
    if (url === "/api/system/quick-chat-config" && method === "PUT") {
      this.setQuickChat(body.run)
      return { status: 200, body: { saved: true } }
    }
    if (url === "/api/model-services") return { status: 200, body: { services: [], suggestions: [], agents: [], providers: [] } }
    if (url === "/api/images") return { status: 200, body: { defaults: { imageName: "ghcr.io/xcanwin/manyoyo", imageVersion: "2.3.0-common" }, images: [] } }
    if (url === "/api/setup/status") return { status: 200, body: { mirrors: this.mirrors } }
    if (url === "/api/setup/agents") return { status: 200, body: { agents: [], mirrorPresets: { apt: [], npm: [{ label: "npmmirror", value: "https://registry.npmmirror.com/" }], pip: [] } } }
    if (url === "/api/setup/mirrors" && method === "POST") {
      this.setMirrors(body.mirrors)
      return { status: 200, body: { saved: true } }
    }
    return { status: 200, body: {} }
  }
}

let container: HTMLDivElement
let root: Root
let server: FakeServer
const BASE_RAW = `{
    // 用户的注释
    hostPath: "/work/a",
    imageVersion: "1.0.0-common",
    serve: { quickChat: { run: "claude", path: "~/.manyoyo/work/" } },
    runs: { claude: { yolo: "c" }, "claude-ds": { yolo: "c" } },
}`
const NO_QUICK_CHAT_RAW = `{
    hostPath: "/work/a",
    imageVersion: "1.0.0-common",
    runs: { claude: { yolo: "c" }, "claude-ds": { yolo: "c" } },
}`

function install(raw: string) {
  server = new FakeServer(raw)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/config" && (init?.method || "GET").toUpperCase() === "PUT" && server.putGate) await server.putGate
      const { status, body } = server.handle(String(url), init)
      return new Response(JSON.stringify(body), { status })
    })
  )
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const tick = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
const byText = (text: string, tag = "button") =>
  Array.from(document.body.querySelectorAll(tag)).find((el) => el.textContent?.trim() === text) as HTMLElement | undefined

async function openDialog() {
  await act(async () => {
    root.render(
      <ThemeProvider>
        <SystemSettingsDialog open onOpenChange={() => {}} />
      </ThemeProvider>
    )
  })
  await tick()
}
async function openCategory(label: string) {
  const tab = Array.from(document.body.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === label) as HTMLElement
  await act(async () => tab.click())
  await tick()
}
async function click(el: HTMLElement | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => el!.click())
  await tick()
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    input.blur()
  })
}
async function editHostPath(value: string) {
  await openCategory("基础")
  const input = Array.from(document.body.querySelectorAll("input")).find((i) => (i as HTMLInputElement).value === "/work/a" || /hostPath/.test(i.id)) as HTMLInputElement
  expect(input).toBeTruthy()
  await typeInto(input, value)
}
// 底部（弹窗页脚）的“保存”是 DOM 里最后一个叫“保存”的按钮
const saveOuter = () => Array.from(document.body.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "保存").pop()

describe("系统设置：保存不覆盖别人的修改", () => {
  test("① 在快捷对话里改 run，再点底部保存：新值保留", async () => {
    install(BASE_RAW)
    await openDialog()
    await openCategory("快捷对话")
    await click(byText("修改"))
    await click(q('[data-testid="quick-chat-save-ds"]'))
    expect(server.raw).toContain('run: "claude-ds"')
    // 自保存分类没有底栏：切到表单分类再点底栏保存，验证版本号已经接过来
    await openCategory("基础")
    await click(saveOuter())
    expect(document.body.textContent).toContain("已保存")
    expect(document.body.textContent).not.toContain("刚被其他地方修改过")
    expect(server.puts).toHaveLength(1)
    expect(server.raw).toContain('run: "claude-ds"')
  })

  test("② 在软件源里改源并点面板里的保存，再点底部保存：新值保留", async () => {
    install(BASE_RAW)
    await openDialog()
    await openCategory("软件源")
    const npm = q("#settings-mirror-npm") as HTMLSelectElement
    expect(npm).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(npm, "https://registry.npmmirror.com/")
      npm.dispatchEvent(new Event("change", { bubbles: true }))
    })
    const saves = Array.from(document.body.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "保存软件源")
    await click(saves[0]) // 软件源面板自己的保存
    expect(server.raw).toContain("registry.npmmirror.com")
    await openCategory("基础") // 自保存分类没有底栏
    await click(saveOuter()) // 底部保存
    expect(document.body.textContent).toContain("已保存")
    expect(document.body.textContent).not.toContain("刚被其他地方修改过") // 子面板保存后版本号已经接过来，不该再走冲突
    expect(server.puts).toHaveLength(1)
    expect(server.raw).toContain("registry.npmmirror.com")
  })

  test("③ 配置里原本没有 quickChat：先改基础字段，再第一次设置快捷对话，再保存：两处修改都在", async () => {
    install(NO_QUICK_CHAT_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    await openCategory("快捷对话")
    await click(byText("设置") ?? byText("修改"))
    await click(q('[data-testid="quick-chat-save-ds"]'))
    await click(saveOuter())
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect(server.raw).toContain('run: "claude-ds"')
  })

  test("⑩ 基础：配置里没有 imageName 也能填，保存后写进文件（注释保留）；没填的字段不会被写成空串", async () => {
    install("{\n    // 用户的注释\n    runs: { claude: { yolo: \"c\" } },\n}")
    await openDialog()
    await openCategory("基础")
    expect(document.body.textContent).not.toContain("暂无内容")
    await typeInto(q("#config-field-imageName") as HTMLInputElement, "my/sandbox")
    await typeInto(q("#config-field-imageVersion") as HTMLInputElement, "1.0.0-full")
    await click(saveOuter())
    expect(server.raw).toContain('"imageName": "my/sandbox"')
    expect(server.raw).toContain('"imageVersion": "1.0.0-full"')
    expect(server.raw).toContain("// 用户的注释")
    expect(server.raw).not.toContain("hostPath")
    expect(server.raw).not.toContain("containerName")
  })

  test("⑪ 基础：新填的字段在保存时遇到外部修改，仍然保存下来", async () => {
    install(BASE_RAW)
    await openDialog()
    await openCategory("基础")
    await typeInto(q("#config-field-imageName") as HTMLInputElement, "my/sandbox")
    server.external('"/work/a"', '"/work/external"')
    await click(saveOuter())
    expect(server.raw).toContain('"imageName": "my/sandbox"')
    expect(server.raw).toContain('hostPath: "/work/external"')
  })

  test("④ 弹窗开着时外部改了文件：点保存自动在最新内容上重放，两边的修改都在，并给出提示", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    server.external('"1.0.0-common"', '"9.9.9-common"')
    await click(saveOuter())
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect(server.raw).toContain('imageVersion: "9.9.9-common"')
    expect(server.raw).toContain("// 用户的注释")
    expect(document.body.textContent).toContain("配置文件刚被其他地方修改过，已在最新内容上保存你的修改")
  })

  test("⑤ JSON 模式下冲突：不自动覆盖，出现两个按钮；选“仍然保存”才覆盖，选“重新加载”放弃自己的修改", async () => {
    install(BASE_RAW)
    await openDialog()
    await click(byText("显示 JSON 设置"))
    const editor = q('[data-testid="json-editor"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, BASE_RAW.replace('"/work/a"', '"/json/mine"'))
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    })
    server.external('"1.0.0-common"', '"9.9.9-common"')
    await click(saveOuter())
    expect(server.raw).not.toContain("/json/mine")
    expect(server.raw).toContain("9.9.9-common")
    const reload = byText("重新加载（放弃我的修改）")
    const force = byText("仍然保存（覆盖对方的修改）")
    expect(reload).toBeTruthy()
    expect(force).toBeTruthy()
    await click(force)
    expect(server.raw).toContain("/json/mine")
    expect(server.raw).not.toContain("9.9.9-common")
  })

  test("⑥ 同一个字段两边都改了：以我的为准，提示里写出字段名", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    server.external('"/work/a"', '"/work/other"')
    await click(saveOuter())
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect(document.body.textContent).toContain("hostPath 两边都改了，以你的为准")
  })

  test("⑤b JSON 模式下冲突后选“重新加载（放弃我的修改）”：文本变成最新内容，不写盘", async () => {
    install(BASE_RAW)
    await openDialog()
    await click(byText("显示 JSON 设置"))
    const editor = q('[data-testid="json-editor"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, BASE_RAW.replace('"/work/a"', '"/json/mine"'))
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    })
    server.external('"1.0.0-common"', '"9.9.9-common"')
    await click(saveOuter())
    const before = server.raw
    await click(byText("重新加载（放弃我的修改）"))
    expect(server.raw).toBe(before)
    await click(byText("显示 JSON 设置")) // 重新加载后回到分类设置视图
    expect((q('[data-testid="json-editor"]') as HTMLTextAreaElement).value).toContain("9.9.9-common")
    expect((q('[data-testid="json-editor"]') as HTMLTextAreaElement).value).not.toContain("/json/mine")
  })

  test("⑧ 我改过的字段被外部删掉：提示里写出字段名，其余修改保留", async () => {
    install(BASE_RAW)
    await openDialog()
    await openCategory("基础")
    const version = Array.from(document.body.querySelectorAll("input")).find((i) => (i as HTMLInputElement).value === "1.0.0-common") as HTMLInputElement
    await typeInto(version, "2.0.0-common")
    await editHostPath("/work/mine")
    server.external('    imageVersion: "1.0.0-common",\n', "")
    await click(saveOuter())
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect(server.raw).not.toContain("imageVersion")
    expect(document.body.textContent).toContain("imageVersion 在最新内容里已经不存在，这项修改没有保存")
  })

  test("⑦ 每次保存都撞上冲突：最多自动重试一次，然后停下并提示，不无限重试", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    // 每个 PUT 到达之前，文件又被改一次（模拟另一个一直在写的进程）
    const original = server.handle.bind(server)
    let n = 0
    server.handle = (url, init) => {
      if (url === "/api/config" && (init?.method || "GET").toUpperCase() === "PUT") {
        n += 1
        server.external(/imageVersion: "[^"]*"/.exec(server.raw)![0], `imageVersion: "v${n}"`)
      }
      return original(url, init)
    }
    await click(saveOuter())
    expect(server.puts.length).toBeLessThanOrEqual(2)
    expect(server.raw).not.toContain('hostPath: "/work/mine"')
    expect(document.body.textContent).toContain("再点一次保存")
  })

  test("⑨ 外部把配置写坏了（409 带回空内容）：我的修改还在表单里，给出提示，不清空", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    server.raw = "BROKEN {"
    await click(saveOuter())
    expect(server.raw).toBe("BROKEN {")
    expect(document.body.textContent).toContain("配置文件当前无法解析")
    await openCategory("基础")
    const values = Array.from(document.body.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value)
    expect(values).toContain("/work/mine")
  })

  test("⑩ 保存请求还在路上时又改了别的字段：这项修改不会因为保存成功被抹掉，之后冲突时仍然会重放", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    let release: () => void = () => {}
    server.putGate = new Promise<void>((resolve) => { release = resolve })
    await act(async () => { saveOuter()!.click() })
    // 保存在途：改另一个字段
    await openCategory("基础")
    const version = Array.from(document.body.querySelectorAll("input")).find((i) => (i as HTMLInputElement).value === "1.0.0-common") as HTMLInputElement
    await typeInto(version, "2.0.0-common")
    server.putGate = null
    await act(async () => release())
    await tick()
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect(server.raw).toContain("1.0.0-common") // 第二项还没保存
    server.external('serve: { quickChat: { run: "claude"', 'serve: { quickChat: { run: "claude-x"') // 别处又改了文件
    await click(saveOuter())
    expect(server.raw).toContain('imageVersion: "2.0.0-common"')
    expect(server.raw).toContain('run: "claude-x"')
  })

  test("⑪ 在 JSON 里手改过、切回表单，再在快捷对话里保存：立刻提示冲突让用户选，不会稍后悄悄覆盖", async () => {
    install(BASE_RAW)
    await openDialog()
    await click(byText("显示 JSON 设置"))
    const editor = q('[data-testid="json-editor"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, BASE_RAW.replace('"/work/a"', '"/json/mine"'))
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await click(byText("返回分类设置"))
    await openCategory("快捷对话")
    await click(byText("修改"))
    await click(q('[data-testid="quick-chat-save-ds"]'))
    expect(server.raw).toContain('run: "claude-ds"')
    expect(byText("仍然保存（覆盖对方的修改）")).toBeTruthy()
    await click(byText("重新加载（放弃我的修改）"))
    expect(server.raw).toContain('run: "claude-ds"')
    expect(server.raw).not.toContain("/json/mine")
  })

  test("⑫ 软件源面板里选了还没保存的值，这时底部保存遇到冲突并自动重放：面板里的选择不会丢", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/mine")
    await openCategory("软件源")
    const npm = q("#settings-mirror-npm") as HTMLSelectElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(npm, "https://registry.npmmirror.com/")
      npm.dispatchEvent(new Event("change", { bubbles: true }))
    })
    server.external('"1.0.0-common"', '"9.9.9-common"')
    await click(saveOuter())
    expect(server.raw).toContain('hostPath: "/work/mine"')
    expect((q("#settings-mirror-npm") as HTMLSelectElement).value).toBe("https://registry.npmmirror.com/")
  })
})

describe("系统设置左侧按作用范围分组", () => {
  test("组标题按顺序出现，每组下面是对应的分类，新增“系统提示词”", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ raw: "{}", etag: "v1", path: "/x/manyoyo.json" }))))
    await openDialog()
    const list = document.body.querySelector('[role="tablist"]') as HTMLElement
    const items = Array.from(list.children).map((el) =>
      el.getAttribute("role") === "tab"
        ? (el.querySelector(".sm\\:inline")?.textContent ?? el.textContent)?.trim()
        : `#${el.getAttribute("data-group")}`
    )
    expect(items).toEqual([
      "#界面", "页面",
      "#Agent", "模型服务", "快捷对话", "系统提示词",
      "#新容器默认值", "基础", "启动环境", "运行命令", "运行配置", "软件源",
      "#镜像", "构建参数",
      "#MANYOYO 服务", "Web 服务", "插件",
      "#宿主机与维护", "环境检查", "容量预估", "磁盘占用", "容器状态",
    ])
  })
})

// STYLE.md 第 8 节：内容自己会保存的分类不显示外层“保存 / 重新加载”底栏
describe("系统设置：外层底栏只在需要时出现", () => {
  const SELF_SAVING = ["页面", "模型服务", "快捷对话", "系统提示词", "软件源", "环境检查", "容量预估", "磁盘占用", "容器状态"]
  const FORM = ["基础", "启动环境", "运行命令", "运行配置", "构建参数", "Web 服务", "插件"]
  const reload = () => byText("重新加载")

  test.each(SELF_SAVING)("自保存分类「%s」没有外层保存 / 重新加载", async (label) => {
    install(BASE_RAW)
    await openDialog()
    await openCategory(label)
    expect(saveOuter()).toBeUndefined()
    expect(reload()).toBeUndefined()
  })

  test.each(FORM)("表单分类「%s」有外层保存 / 重新加载", async (label) => {
    install(BASE_RAW)
    await openDialog()
    await openCategory(label)
    expect(saveOuter()).toBeTruthy()
    expect(reload()).toBeTruthy()
  })

  test("在表单里改了还没保存，切到自保存分类，保存按钮仍然在（修改不能悄悄悬着）", async () => {
    install(BASE_RAW)
    await openDialog()
    await editHostPath("/work/b")
    await openCategory("模型服务")
    expect(saveOuter()).toBeTruthy()
    await click(saveOuter())
    expect(server.raw).toContain("/work/b")
    // 保存完没有未保存的修改了，底栏收起
    expect(saveOuter()).toBeUndefined()
  })

  test("“显示 JSON 设置”在页头，任何分类都能用；JSON 视图有底栏", async () => {
    install(BASE_RAW)
    await openDialog()
    await openCategory("模型服务")
    expect(saveOuter()).toBeUndefined()
    const header = q('[data-slot="dialog-header"]')!
    const toggle = Array.from(header.querySelectorAll("button")).find((b) => b.textContent?.includes("显示 JSON 设置"))
    expect(toggle).toBeTruthy()
    await click(toggle)
    expect(q('[data-testid="json-editor"]')).toBeTruthy()
    expect(saveOuter()).toBeTruthy()
  })

  test("手机上：页头 ⋯ 里有“显示 JSON 设置 / 重新加载”，底栏只剩一个整行的“保存”", async () => {
    const old = window.innerWidth
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true })
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
    try {
      install(BASE_RAW)
      await openDialog()
      const header = q('[data-slot="dialog-header"]')!
      expect(Array.from(header.querySelectorAll("button")).some((b) => b.textContent?.includes("显示 JSON 设置"))).toBe(false)
      await click(header.querySelector('button[aria-label="更多"]') as HTMLElement)
      const item = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes("显示 JSON 设置")) as HTMLElement
      expect(item).toBeTruthy()
      expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).some((el) => el.textContent?.includes("重新加载"))).toBe(true)
      await click(item)
      const footerButtons = Array.from(q('[data-slot="dialog-footer"]')!.querySelectorAll("button"))
      expect(footerButtons.map((b) => b.textContent?.trim())).toEqual(["保存"])
    } finally {
      Object.defineProperty(window, "innerWidth", { value: old, configurable: true })
    }
  })
})
