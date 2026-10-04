import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { ConfirmDialog, RunAllDialog } from "./dialogs"

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

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("RunAllDialog", () => {
  test("step mode starts directly; one-time confirmation needs the word publish", async () => {
    const onStart = vi.fn()
    await act(async () => {
      root.render(<RunAllDialog stages={["合并到 main", "Release"]} notesDraft="## 更新内容" onStart={onStart} onCancel={() => {}} />)
    })
    expect(document.body.textContent).toContain("合并到 main → Release")
    expect(buttonByText("开始")!.disabled).toBe(false)

    await act(async () => {
      buttonByText("一次确认")!.click()
    })
    expect(buttonByText("开始")!.disabled).toBe(true)
    const input = document.body.querySelector("input") as HTMLInputElement
    await type(input, "nope")
    expect(buttonByText("开始")!.disabled).toBe(true)
    await type(input, "publish")
    expect(buttonByText("开始")!.disabled).toBe(false)
    await act(async () => {
      buttonByText("开始")!.click()
    })
    expect(onStart).toHaveBeenCalledWith("auto", "## 更新内容")
  })
})

describe("RunAllDialog notes", () => {
  test("shows the full release notes before starting and will not start without them", async () => {
    const onStart = vi.fn()
    await act(async () => {
      root.render(<RunAllDialog stages={["Release"]} notesDraft="## 更新内容\n- fix: 修 403" onStart={onStart} onCancel={() => {}} />)
    })
    const area = document.body.querySelector("textarea") as HTMLTextAreaElement
    expect(area.value).toContain("fix: 修 403")
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(area, "  ")
      area.dispatchEvent(new Event("input", { bubbles: true }))
    })
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
