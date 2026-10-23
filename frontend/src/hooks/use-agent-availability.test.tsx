import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useAgentAvailability } from "@/hooks/use-agent-availability"

const fetchSetupAgents = vi.hoisted(() => vi.fn())
vi.mock("@/lib/setup", () => ({ fetchSetupAgents }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  fetchSetupAgents.mockReset()
  container = document.createElement("div")
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
})

function Probe({ enabled }: { enabled: boolean }) {
  const ok = useAgentAvailability(enabled)
  return <p>{["claude", "gemini"].map((id) => `${id}:${ok(id)}`).join(",")}</p>
}

describe("useAgentAvailability", () => {
  test("available=false 的不可用，null 和 true 可用", async () => {
    fetchSetupAgents.mockResolvedValue([
      { id: "claude", available: true },
      { id: "gemini", available: false },
      { id: "codex", available: null },
    ])
    await act(async () => root.render(<Probe enabled />))
    await act(async () => {})
    expect(container.textContent).toBe("claude:true,gemini:false")
  })

  test("没打开时不请求；请求失败都可选", async () => {
    await act(async () => root.render(<Probe enabled={false} />))
    expect(fetchSetupAgents).not.toHaveBeenCalled()
    fetchSetupAgents.mockRejectedValue(new Error("x"))
    await act(async () => root.render(<Probe enabled />))
    await act(async () => {})
    expect(container.textContent).toBe("claude:true,gemini:true")
  })
})
