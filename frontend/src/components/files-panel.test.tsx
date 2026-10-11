import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { FilesPanel } from "./files-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
declare const process: { env: Record<string, string | undefined> }

vi.mock("@/components/code-mirror-editor", () => ({
  CodeMirrorEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}))

// 假版本号：内容的简单哈希（真实服务端用 sha256）
const sha = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `v${text.length}-${h}`
}

// 假的容器文件：接口语义与 lib/web/server.js 一致（读返回 etag；写必须带 If-Match：428 / 409 / 200）
class FakeContainerFile {
  content = "原始内容\n"
  otherContent = "另一个文件\n"
  writes: Array<{ content: string; ifMatch: string | null }> = []
  // 非空时，fs/write 先等它（模拟保存请求还在路上）
  writeGate: Promise<void> | null = null
  handle(url: string, init: RequestInit = {}): { status: number; body: unknown } {
    const method = (init.method || "GET").toUpperCase()
    if (url.includes("/fs/list")) {
      return {
        status: 200,
        body: {
          path: "/",
          parentPath: "",
          entries: [
            { name: "a.txt", path: "/a.txt", kind: "file", size: this.content.length, mtimeMs: 1 },
            { name: "b.txt", path: "/b.txt", kind: "file", size: this.otherContent.length, mtimeMs: 1 },
          ],
        },
      }
    }
    if (url.includes("/fs/read")) {
      const other = decodeURIComponent(url).includes("path=/b.txt")
      const content = other ? this.otherContent : this.content
      return { status: 200, body: { path: other ? "/b.txt" : "/a.txt", kind: "text", size: content.length, truncated: false, content, language: "text", editable: true, etag: sha(content) } }
    }
    if (url.includes("/fs/write") && method === "PUT") {
      const body = JSON.parse(String(init.body))
      const ifMatch = new Headers(init.headers).get("If-Match")
      this.writes.push({ content: body.content, ifMatch })
      const isOther = body.path === "/b.txt"
      const current = isOther ? this.otherContent : this.content
      const store = (text: string) => { if (isOther) this.otherContent = text; else this.content = text }
      // FAKE_SERVER_LEGACY=1：模拟改版前的服务端（不带版本也直接覆盖），用来在旧前端上复现原始问题
      if (process.env.FAKE_SERVER_LEGACY === "1" && ifMatch === null) {
        store(body.content)
        return { status: 200, body: { saved: true } }
      }
      if (ifMatch === null) return { status: 428, body: { error: "需要 If-Match" } }
      if (ifMatch !== sha(current)) return { status: 409, body: { error: "文件已在容器里被修改", conflict: true } }
      store(body.content)
      return { status: 200, body: { path: body.path, saved: true, size: body.content.length, etag: sha(body.content) } }
    }
    return { status: 200, body: {} }
  }
}

const session = { name: "demo", containerName: "demo", agentId: "default", status: "running" } as SessionSummary
let container: HTMLDivElement
let root: Root
let file: FakeContainerFile

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  file = new FakeContainerFile()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/fs/write") && file.writeGate) await file.writeGate
      const { status, body } = file.handle(String(url), init)
      return new Response(JSON.stringify(body), { status })
    })
  )
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
const byText = (text: string) => Array.from(document.body.querySelectorAll("button")).find((el) => el.textContent?.trim() === text) as HTMLElement | undefined
const editor = () => document.body.querySelector('[data-testid="editor"]') as HTMLTextAreaElement
async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
  await tick()
}
async function typeInEditor(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), text)
    editor().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function openFileAndEdit(mine: string) {
  await act(async () => {
    root.render(<FilesPanel activeSession={session} confirmLeaveIfDirty={async () => true} />)
  })
  await tick()
  const entry = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("a.txt"))
  await click(entry)
  expect(editor().value).toBe("原始内容\n")
  await typeInEditor(mine)
}
const saveButton = () => byText("保存")

describe("文件面板：保存不覆盖容器里刚改过的文件", () => {
  test("正常保存带着读取时的版本，保存后可以继续保存（版本号随保存更新）", async () => {
    await openFileAndEdit("第一次\n")
    await click(saveButton())
    expect(file.content).toBe("第一次\n")
    expect(file.writes[0].ifMatch).toBe(sha("原始内容\n"))
    await typeInEditor("第二次\n")
    await click(saveButton())
    expect(file.content).toBe("第二次\n")
    expect(file.writes[1].ifMatch).toBe(sha("第一次\n"))
  })

  test("容器里的文件被改过：不覆盖，显示冲突提示和两个按钮", async () => {
    await openFileAndEdit("我的修改\n")
    file.content = "Agent 刚改的\n"
    await click(saveButton())
    expect(file.content).toBe("Agent 刚改的\n")
    expect(document.body.textContent).toContain("文件已在容器里被修改")
    expect(byText("重新加载")).toBeTruthy()
    expect(byText("仍然保存")).toBeTruthy()
  })

  test("“重新加载”放弃本地内容，编辑器显示容器里的新内容，不写盘", async () => {
    await openFileAndEdit("我的修改\n")
    file.content = "Agent 刚改的\n"
    await click(saveButton())
    const writes = file.writes.length
    await click(byText("重新加载"))
    expect(editor().value).toBe("Agent 刚改的\n")
    expect(file.writes.length).toBe(writes)
    expect(document.body.textContent).not.toContain("文件已在容器里被修改")
  })

  test("“仍然保存”用最新的版本再写一次，覆盖对方的修改", async () => {
    await openFileAndEdit("我的修改\n")
    file.content = "Agent 刚改的\n"
    await click(saveButton())
    await click(byText("仍然保存"))
    expect(file.content).toBe("我的修改\n")
    expect(file.writes[file.writes.length - 1].ifMatch).toBe(sha("Agent 刚改的\n"))
    expect(document.body.textContent).not.toContain("文件已在容器里被修改")
  })

  // 审查：保存在途时切换到别的文件，保存的结果不能写进新文件的状态
  test("保存在途时切换到别的文件：旧文件的内容和版本不会写进新文件，新文件之后能正常保存", async () => {
    await openFileAndEdit("我的修改\n")
    let release: () => void = () => {}
    file.writeGate = new Promise<void>((resolve) => { release = resolve })
    await act(async () => { saveButton()!.click() })
    file.writeGate = null
    const entryB = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("b.txt"))
    await click(entryB)
    expect(editor().value).toBe("另一个文件\n")
    await act(async () => release())
    await tick()
    expect(editor().value).toBe("另一个文件\n")
    await typeInEditor("改了 b\n")
    await click(saveButton())
    expect(file.otherContent).toBe("改了 b\n")
    expect(document.body.textContent).not.toContain("文件已在容器里被修改")
  })

  test("冲突提示出现后点“取消”放弃编辑：提示一起消失，不留下点不动的按钮", async () => {
    await openFileAndEdit("我的修改\n")
    file.content = "Agent 刚改的\n"
    await click(saveButton())
    expect(byText("仍然保存")).toBeTruthy()
    await click(byText("取消"))
    expect(byText("仍然保存")).toBeUndefined()
  })
})
