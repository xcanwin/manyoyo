import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ConfirmDialog, RemoteDialog } from "./dialogs"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const buttonByText = (text: string) =>
  [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined

describe("RemoteDialog（一键发布）", () => {
  const base = { version: "8.7.0", willBump: false, commits: ["fix: 修 403", "feat: 新增 A"], notes: "## 更新内容\n- fix: 修 403", problem: "", onCancel: () => {} }

  test("只显示版本、提交列表和自动生成的说明，没有任何输入框，点一次「开始」就发出", async () => {
    const onStart = vi.fn()
    await act(async () => {
      root.render(<RemoteDialog {...base} onStart={onStart} />)
    })
    expect(document.body.textContent).toContain("8.7.0")
    expect(document.body.textContent).toContain("fix: 修 403")
    expect(document.body.textContent).toContain("feat: 新增 A")
    expect(document.body.textContent).toContain("## 更新内容")
    expect(document.body.querySelector("input")).toBeNull()
    expect(document.body.querySelector("textarea")).toBeNull()
    expect(buttonByText("开始")!.disabled).toBe(false)
    await act(async () => {
      buttonByText("开始")!.click()
    })
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  test("版本还没升时说明会自动升版本并提交；有问题（未提交的文件等）时不能开始", async () => {
    await act(async () => {
      root.render(<RemoteDialog {...base} version="8.6.4" willBump onStart={() => {}} />)
    })
    expect(document.body.textContent).toContain("自动升到 8.6.4")
    await act(async () => {
      root.render(<RemoteDialog {...base} problem="有 2 个文件未提交" onStart={() => {}} />)
    })
    expect(document.body.textContent).toContain("有 2 个文件未提交")
    expect(buttonByText("开始")!.disabled).toBe(true)
  })
})

describe("ConfirmDialog", () => {
  test("lists the commands that will run and reports the choice", async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    await act(async () => {
      root.render(<ConfirmDialog title="合并到 main" commands={["git push origin main"]} onConfirm={onConfirm} onCancel={onCancel} />)
    })
    expect(document.body.textContent).toContain("git push origin main")
    await act(async () => {
      buttonByText("确认执行")!.click()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})
