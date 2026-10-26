import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ContainerGroup, SessionSummary } from "@/lib/api"
import { SIDEBAR_SORT_STORAGE_KEY } from "@/lib/sidebar-sort"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const calls: { url: string; body: unknown }[] = []

beforeEach(() => {
  window.localStorage.clear()
  window.matchMedia = ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown) as typeof window.matchMedia
  calls.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const preview = { tiers: [{ id: "standard", label: "标准" }], items: [{ id: "history", label: "网页聊天记录", hint: "", tiers: ["standard"] }], estimates: { history: 0 }, containers: [], zstd: true, freeBytes: null }
      return new Response(JSON.stringify(String(url).startsWith("/api/transfer/preview") ? preview : String(url).startsWith("/api/jobs/") ? { job: { id: "0123456789abcdef", type: "export", status: "running", containers: ["a-box"], stage: "容器内数据", container: "a-box", bytes: 10, estimate: 100, error: "", result: null, cancelRequested: false } } : {}), { status: 200, headers: { "content-type": "application/json" } })
    })
  )
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

const session = (containerName: string, updatedAt: string): SessionSummary =>
  ({
    name: containerName, containerName, agentId: "default", agentName: "AGENT 1", agentRemark: "", containerRemark: "",
    status: "Up 1 hour", image: "", createdAt: updatedAt, updatedAt, messageCount: 1, agentEnabled: true,
    agentProgram: "claude", resumeSupported: true, model: "", hostPath: "", containerPath: "",
  }) as SessionSummary
const group = (containerName: string, updatedAt: string, extra: Partial<ContainerGroup> = {}): ContainerGroup => ({
  containerName, containerRemark: "", status: "Up 1 hour", image: "", hostPath: "", updatedAt, sessions: [session(containerName, updatedAt)], ...extra,
})

type Props = { groups: ContainerGroup[]; onRefresh?: () => Promise<SessionSummary[]> }
async function mount({ groups, onRefresh = async () => [] }: Props) {
  await act(async () =>
    root.render(
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              containers={groups}
              loading={false}
              error=""
              activeSessionName={null}
              onSelectSession={() => {}}
              onRefresh={onRefresh}
              confirmLeaveIfDirty={async () => true}
              creatingAgentContainer={null}
              onCreatingAgentContainerChange={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </ThemeProvider>
    )
  )
}
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const find = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button,[role=menuitem],[role=menuitemradio]")].find(
    (el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label
  )
const press = async (label: string) => {
  const el = find(label)
  expect(el, label).toBeTruthy()
  await act(async () => el!.click())
  await tick()
}
const order = () => [...document.querySelectorAll("[data-container-name]")].map((el) => el.getAttribute("data-container-name"))

describe("侧栏排序", () => {
  const groups = [group("a-box", "2026-10-01T00:00:00Z"), group("b-box", "2026-10-03T00:00:00Z"), group("c-box", "2026-10-02T00:00:00Z")]
  test("默认按修改时间；在菜单里改成按名称，列表立刻换序并记住偏好", async () => {
    await mount({ groups })
    expect(order()).toEqual(["b-box", "c-box", "a-box"])
    await press("排序")
    await press("按名称")
    expect(order()).toEqual(["a-box", "b-box", "c-box"])
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY) ?? "{}")).toMatchObject({ containers: "name" })
  })
  test("置顶的容器始终在最前，并显示图钉", async () => {
    await mount({ groups: [...groups, group("pin-box", "2026-09-01T00:00:00Z", { pinned: true })] })
    expect(order()[0]).toBe("pin-box")
    expect(document.querySelector('[data-container-name="pin-box"] [aria-label="已置顶"]')).toBeTruthy()
  })
})

describe("容器置顶", () => {
  test("⋯ 菜单里“置顶容器”调用接口", async () => {
    await mount({ groups: [group("a-box", "2026-10-01T00:00:00Z")] })
    await press("更多操作")
    await press("置顶容器")
    expect(calls.find((c) => c.url === "/api/sessions/a-box/container-pin")?.body).toEqual({ pinned: true })
  })
})

describe("删除中", () => {
  test("确认后卡片转圈并禁用，等列表刷新完才恢复", async () => {
    let finishRefresh: () => void = () => {}
    const refreshed = new Promise<SessionSummary[]>((resolve) => { finishRefresh = () => resolve([]) })
    await mount({ groups: [group("a-box", "2026-10-01T00:00:00Z")], onRefresh: () => refreshed })
    await press("更多操作")
    await press("删除容器")
    await press("否，保留历史")
    const card = () => document.querySelector('[data-container-name="a-box"]')!
    expect(card().querySelector('[aria-label="删除中"]')).toBeTruthy()
    expect(card().querySelector("button[aria-busy]")?.hasAttribute("disabled")).toBe(true)
    expect(card().textContent).not.toContain("运行中")
    await act(async () => finishRefresh())
    await tick()
    expect(card().querySelector('[aria-label="删除中"]')).toBeNull()
    expect(card().textContent).toContain("运行中")
  })
})

describe("导出 / 导入中的容器", () => {
  const job = { id: "0123456789abcdef", type: "export" as const, stage: "容器内数据", bytes: 10, estimate: 100 }
  test("卡片转圈并禁用 ⋯；点卡片打开进度弹窗而不是进入容器", async () => {
    await mount({ groups: [group("a-box", "2026-10-01T00:00:00Z", { job })] })
    const card = () => document.querySelector('[data-container-name="a-box"]')!
    expect(card().querySelector('[aria-label="导出中"]')).toBeTruthy()
    expect(card().textContent).not.toContain("运行中")
    expect((card().querySelector('[aria-label="更多操作"]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => (card().querySelector("button[aria-busy]") as HTMLButtonElement).click())
    await tick()
    expect(calls.some((c) => c.url === "/api/jobs/0123456789abcdef")).toBe(true)
    expect(document.body.textContent).toContain("正在导出")
  })

  test("容器 ⋯ 菜单有“导出…”，全局入口有“导出容器… / 导入容器…”", async () => {
    await mount({ groups: [group("a-box", "2026-10-01T00:00:00Z")] })
    await press("更多操作")
    expect(find("导出…")).toBeTruthy()
    await press("导出…")
    await tick()
    expect(document.body.textContent).toContain("导出容器")
    expect(calls.some((c) => c.url.startsWith("/api/transfer/preview?containers=a-box"))).toBe(true)
  })

  test("全局入口：导入容器…", async () => {
    await mount({ groups: [group("a-box", "2026-10-01T00:00:00Z")] })
    await press("导出 / 导入")
    await press("导入容器…")
    expect(document.body.textContent).toContain("选一个 manyoyo 导出的文件")
  })
})
