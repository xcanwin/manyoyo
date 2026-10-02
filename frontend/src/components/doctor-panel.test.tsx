import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DoctorPanel } from "@/components/doctor-panel"
import * as doctorApi from "@/lib/doctor"
import type { DoctorReport } from "@/lib/doctor"

vi.mock("@/lib/doctor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/doctor")>()),
  fetchDoctor: vi.fn(),
  runDoctorFix: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.mocked(doctorApi)
let container: HTMLDivElement
let root: Root

const broken: DoctorReport = {
  ok: false,
  checks: [
    { code: "RUNTIME_AVAILABLE", status: "ok", summary: "容器运行时: podman", action: "", detail: "" },
    { code: "DAEMON_UNAVAILABLE", status: "error", summary: "podman daemon 不可用", action: "启动 podman daemon 后重试。", detail: "connection refused" },
    { code: "IMAGE_MISSING", status: "warning", summary: "目标镜像尚不可用", action: "拉取匹配镜像。", detail: "" },
  ],
}
const fixed: DoctorReport = {
  ok: true,
  checks: [
    { code: "RUNTIME_AVAILABLE", status: "ok", summary: "容器运行时: podman", action: "", detail: "" },
    { code: "DAEMON_UNAVAILABLE", status: "error", summary: "podman daemon 不可用", action: "", detail: "", fix: { attempted: true, fixed: true, message: "已启动虚拟机" } },
  ],
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
const text = () => container.textContent ?? ""
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(label)) as HTMLButtonElement | undefined

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("element not found")
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function mount() {
  await act(async () => {
    root.render(<DoctorPanel />)
  })
  await flush()
}

describe("DoctorPanel", () => {
  test("lists every check with status, reason and next step", async () => {
    api.fetchDoctor.mockResolvedValue(broken)
    await mount()
    const items = Array.from(container.querySelectorAll("li"))
    expect(items.map((li) => li.dataset.status)).toEqual(["ok", "error", "warning"])
    expect(text()).toContain("失败")
    expect(text()).toContain("警告")
    expect(text()).toContain("下一步：启动 podman daemon 后重试。")
    expect(text()).toContain("connection refused")
    // 通过项不展示“下一步”
    expect(items[0].textContent).not.toContain("下一步")
  })

  test("the fix button only shows for fixable problems and replaces the report with the fix result", async () => {
    api.fetchDoctor.mockResolvedValue(broken)
    api.runDoctorFix.mockResolvedValue(fixed)
    await mount()
    await click(button("尝试自动修复"))
    expect(api.runDoctorFix).toHaveBeenCalledTimes(1)
    expect(text()).toContain("已修复：已启动虚拟机")
    expect(button("尝试自动修复")).toBeUndefined()
  })

  test("no fix button when everything passes", async () => {
    api.fetchDoctor.mockResolvedValue({ ok: true, checks: [broken.checks[0]] })
    await mount()
    expect(button("尝试自动修复")).toBeUndefined()
  })

  test("shows the error when the check fails and can retry", async () => {
    api.fetchDoctor.mockRejectedValueOnce(new Error("环境检查不可用")).mockResolvedValueOnce(broken)
    await mount()
    expect(text()).toContain("环境检查不可用")
    await click(button("重新检查"))
    expect(text()).toContain("podman daemon 不可用")
  })
})
