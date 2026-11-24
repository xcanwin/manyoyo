import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { NetworkEditor } from "@/components/container-manage/network-editor"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type NetworkPolicy, defaultPolicy, newRule } from "@/lib/container-manage"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.matchMedia = window.matchMedia || ((() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function policy(overrides: Partial<NetworkPolicy>): NetworkPolicy {
  return { ...defaultPolicy(), ...overrides }
}

async function render(next: NetworkPolicy) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <NetworkEditor policy={next} onChange={() => {}} />
      </TooltipProvider>
    )
  })
  return container.textContent ?? ""
}

describe("NetworkEditor 拒绝域名提示", () => {
  test("收紧模式下有拒绝域名规则：说明直连覆盖端口（默认 80/443）也会被拒绝", async () => {
    const text = await render(policy({ outbound: [newRule("outbound", "ads.example.com", { action: "deny" })] }))
    expect(text).toContain("直连这些规则覆盖的端口")
  })

  test("只有允许域名 / 已暂停的拒绝行不提示；仅白名单不重复提示", async () => {
    expect(await render(policy({ outbound: [newRule("outbound", "a.example.com")] }))).not.toContain("直连这些规则覆盖的端口")
    expect(await render(policy({ outbound: [newRule("outbound", "ads.example.com", { action: "deny", enabled: false })] }))).not.toContain("直连这些规则覆盖的端口")
    expect(await render(policy({ preset: "allowlist", outbound: [newRule("outbound", "ads.example.com", { action: "deny" })] }))).not.toContain("直连这些规则覆盖的端口")
  })
})
