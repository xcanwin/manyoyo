import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ContainerGroup, SessionSummary } from "@/lib/api"
import { SearchDialog } from "./search-dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = () => {}
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("会话标题只按纯文本显示", () => {
  test("Agent 生成的标题里带标签也不会变成元素", async () => {
    const session = { name: "c~a", containerName: "c", agentId: "a", agentName: "AGENT 1", agentRemark: "", agentTitle: '<img src=x onerror="alert(1)">标题' } as SessionSummary
    const groups = [{ containerName: "c", containerRemark: "", status: "Up", image: "", hostPath: "/w", updatedAt: "", sessions: [session] }] as ContainerGroup[]
    await act(async () => {
      root.render(<SearchDialog open onOpenChange={() => {}} containers={groups} onSelectContainer={() => {}} onSelectAgent={() => {}} />)
    })
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">标题')
    expect(document.body.querySelector("img")).toBeNull()
  })
})
