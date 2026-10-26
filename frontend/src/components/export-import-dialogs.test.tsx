import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ExportDialog } from "@/components/export-dialog"
import { ImportDialog } from "@/components/import-dialog"

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
    suggestedName: "box1-2", suggestedHostPath: "/new/box1-2", risks: { containerMode: "sock", autostart: true },
  }],
}

let container: HTMLDivElement
let root: Root
const calls: { method: string; url: string; body: unknown }[] = []
beforeEach(() => {
  calls.length = 0
  window.matchMedia = ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown) as typeof window.matchMedia
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    let body: unknown
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = undefined }
    calls.push({ method, url: String(url), body })
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
    if (String(url).startsWith("/api/transfer/preview")) return reply(PREVIEW)
    if (String(url) === "/api/exports" && method === "POST") return reply({ jobId: "j1", output: "server", file: "x.tar.zst" })
    if (String(url) === "/api/exports") return reply({ dir: "~/.manyoyo/exports", files: [{ name: "manyoyo-export-20261027-000000.tar.zst", size: 1000, mtime: "2026-10-27T00:00:00Z" }], freeBytes: 1 })
    if (String(url) === "/api/imports/inspect") return reply(MANIFEST)
    if (String(url) === "/api/imports") return reply({ jobId: "j2", containers: ["box1-2"] })
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
  test("选服务器上的文件 → 先看清单（自动换名、风险项默认不勾）→ 不勾风险直接导入，confirm 全是空", async () => {
    await act(async () => root.render(<ImportDialog open onOpenChange={() => {}} onImported={() => {}} />))
    await flush()
    await press("服务器上的文件")
    const select = document.getElementById("imp-server-file") as HTMLSelectElement
    await act(async () => {
      select.value = "manyoyo-export-20261027-000000.tar.zst"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flush()
    expect((document.getElementById("imp-name-0") as HTMLInputElement).value).toBe("box1-2")
    expect(text()).toContain("本机已有同名容器")
    expect(text()).toContain("sock 模式")
    expect(text()).toContain("自启动脚本")
    expect(checkboxOf("sock 模式").checked).toBe(false)

    await tick(checkboxOf("自启动脚本"))
    await press("开始导入")
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/imports")
    expect(post?.body).toEqual({
      serverFile: "manyoyo-export-20261027-000000.tar.zst",
      plan: { containers: { 0: { name: "box1-2", hostPath: "/new/box1-2", imageMode: "same", confirm: { volumes: [], ports: false, autostart: true, envFiles: [], networkOpen: false } } } },
    })
  })
})
