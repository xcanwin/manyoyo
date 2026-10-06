import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { EnvEditor } from "@/components/container-manage/env-editor"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function Harness({ initial, onText }: { initial: string; onText: (t: string) => void }) {
  const [text, setText] = React.useState(initial)
  return (
    <EnvEditor
      idPrefix="t"
      value={text}
      invalid={[{ line: 3, text: "1BAD=x", reason: "key 非法: 1BAD" }]}
      onChange={(next) => {
        setText(next)
        onText(next)
      }}
    />
  )
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("EnvEditor", () => {
  test("表格默认遮罩敏感值，点眼睛才显示；普通值直接显示", async () => {
    await act(async () => root.render(<Harness initial={"PATH=/bin\nOPENAI_API_KEY=sk-1\n"} onText={() => {}} />))
    const values = [...container.querySelectorAll<HTMLInputElement>('input[aria-label$="的值"]')]
    expect(values.map((input) => input.type)).toEqual(["text", "password"])
    const eye = container.querySelector<HTMLButtonElement>('button[aria-label="显示值"]')!
    await act(async () => eye.click())
    expect(container.querySelector<HTMLInputElement>('input[aria-label="第 2 项的值"]')!.type).toBe("text")
  })

  test("编辑表格回写成文本；添加变量后空名字的行不会消失；删除一行", async () => {
    const texts: string[] = []
    await act(async () => root.render(<Harness initial={"A=1\n"} onText={(t) => texts.push(t)} />))
    const value = container.querySelector<HTMLInputElement>('input[aria-label="第 1 项的值"]')!
    await act(async () => setInput(value, "2"))
    expect(texts.at(-1)).toBe("A=2\n")

    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("添加变量"))!
    await act(async () => add.click())
    expect(container.querySelectorAll('input[aria-label$="名称"]').length).toBe(2)
    expect(texts.at(-1)).toBe("A=2\n") // 空名字不进文本，但行还在

    const name = container.querySelector<HTMLInputElement>('input[aria-label="第 2 项名称"]')!
    await act(async () => setInput(name, "B"))
    expect(texts.at(-1)).toBe("A=2\nB=\n")

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="删除这一项"]')!.click())
    expect(texts.at(-1)).toBe("B=\n")
  })

  test("非法行（容器里写入的）标红列出", async () => {
    await act(async () => root.render(<Harness initial={"A=1\n"} onText={() => {}} />))
    expect(container.textContent).toContain("第 3 行：1BAD=x")
  })
})
