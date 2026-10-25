import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { SessionSummary } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let openSidebar: () => void = () => {}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true })
  window.matchMedia = ((() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown) as typeof window.matchMedia
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })))
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

function Opener() {
  const { setOpenMobile } = useSidebar()
  openSidebar = () => setOpenMobile(true)
  return null
}

const session = {
  name: "c1", containerName: "c1", agentId: "default", agentName: "AGENT 1", agentRemark: "", containerRemark: "",
  status: "running", image: "", createdAt: null, updatedAt: null, messageCount: 1, agentEnabled: true,
  agentProgram: "claude", resumeSupported: true, model: "", hostPath: "", containerPath: "",
} as SessionSummary

async function mount() {
  await act(async () =>
    root.render(
      <ThemeProvider>
      <TooltipProvider>
        <SidebarProvider>
          <Opener />
          <AppSidebar
            containers={[{ containerName: "c1", containerRemark: "", status: "Up 1 hour", image: "", hostPath: "", updatedAt: "", sessions: [session] }]}
            loading={false}
            error=""
            activeSessionName={null}
            onSelectSession={() => {}}
            onRefresh={async () => []}
            confirmLeaveIfDirty={async () => true}
            creatingAgentContainer={null}
            onCreatingAgentContainerChange={() => {}}
          />
        </SidebarProvider>
      </TooltipProvider>
      </ThemeProvider>
    )
  )
  await act(async () => openSidebar())
}

const sidebarOpen = () => document.querySelector('[data-slot="sidebar"][data-mobile="true"]') !== null
const dialogTitles = () => [...document.querySelectorAll('[data-slot="dialog-title"]')].map((el) => el.textContent)
const clickButton = async (text: string) => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text) || b.getAttribute("aria-label") === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
}

// STYLE.md 第 9 节：手机上侧栏（Sheet）也算一层，从它里面打开弹窗要先收起侧栏
describe("手机侧栏打开弹窗", () => {
  test.each([
    ["新建容器", "新建容器会话"],
    ["系统设置", "系统设置"],
    ["运行日志", "运行日志"],
  ])("点「%s」：侧栏收起、弹窗打开", async (label, title) => {
    await mount()
    expect(sidebarOpen()).toBe(true)
    await clickButton(label)
    expect(sidebarOpen()).toBe(false)
    expect(dialogTitles()).toContain(title)
  })
})
