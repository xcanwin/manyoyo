import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { RuleTable } from "@/components/container-manage/rule-table"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type Rule, newRule } from "@/lib/container-manage"

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

const peers = [{ id: "0123456789abcdef", name: "my-web", running: true, ip: "10.89.0.5" }]

function Harness({ initial, onRules, preset = "restricted" }: { initial: Rule[]; onRules: (rules: Rule[]) => void; preset?: "restricted" | "custom" }) {
  const [rules, setRules] = React.useState(initial)
  return (
    <TooltipProvider>
      <RuleTable
        direction="outbound"
        preset={preset}
        rules={rules}
        containers={peers}
        derived={[{ id: "fedcba9876543210", name: "my-db", ip: "10.89.0.7", ports: "5432", proto: "tcp" }]}
        onChange={(next) => {
          setRules(next)
          onRules(next)
        }}
      />
    </TooltipProvider>
  )
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

describe("RuleTable", () => {
  test("锁定行：顶部两行、派生行、模式默认行都显示且没有输入框", async () => {
    await act(async () => root.render(<Harness initial={[]} onRules={() => {}} />))
    const text = container.textContent ?? ""
    for (const token of ["@cont_local", "@manyoyo", "@container:my-db", "@public", "@metadata"]) expect(text).toContain(token)
    expect(text).toContain("模式默认")
    expect(container.querySelectorAll("input").length).toBe(0)
  })

  test("自定义模式：没有模式默认行，分隔线写“没有匹配的：允许”", async () => {
    await act(async () => root.render(<Harness initial={[]} onRules={() => {}} preset="custom" />))
    expect(container.textContent).toContain("没有匹配的：允许")
    expect(container.textContent).not.toContain("@public")
  })

  test("添加规则、输入 @ 选候选后焦点跳到端口框；上移 / 暂停 / 删除", async () => {
    const seen: Rule[][] = []
    await act(async () => root.render(<Harness initial={[]} onRules={(r) => seen.push(r)} />))
    const add = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("添加出站规则"))!
    await act(async () => add.click())
    await act(async () => add.click())
    const first = container.querySelector<HTMLInputElement>('input[aria-label="出站规则第 1 行目标"]')!
    await act(async () => first.focus())
    await act(async () => setInput(first, "@ho"))
    const options = [...container.querySelectorAll('[role="option"]')]
    expect(options[0].textContent).toContain("@host")
    await act(async () => options[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })))
    expect(seen.at(-1)![0].target).toBe("@host")
    expect(document.activeElement).toBe(container.querySelector('input[aria-label="出站规则第 1 行目标端口"]'))

    const second = container.querySelector<HTMLInputElement>('input[aria-label="出站规则第 2 行目标"]')!
    await act(async () => setInput(second, "github.com"))
    await act(async () => button("上移出站规则第 2 行").click())
    expect(seen.at(-1)!.map((r) => r.target)).toEqual(["github.com", "@host"])
    await act(async () => button("暂停出站规则第 1 行").click())
    expect(seen.at(-1)![0].enabled).toBe(false)
    expect(button("恢复出站规则第 1 行")).toBeTruthy()
    await act(async () => button("删除出站规则第 1 行").click())
    expect(seen.at(-1)!.map((r) => r.target)).toEqual(["@host"])
  })

  test("容器按名称显示、按 id 存储；键盘 ↓ Enter 选择", async () => {
    const seen: Rule[][] = []
    await act(async () => root.render(<Harness initial={[newRule("outbound", "")]} onRules={(r) => seen.push(r)} />))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="出站规则第 1 行目标"]')!
    await act(async () => input.focus())
    await act(async () => setInput(input, "@my-w"))
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(seen.at(-1)![0].target).toBe("@container:0123456789abcdef")
    expect(container.querySelector<HTMLInputElement>('input[aria-label="出站规则第 1 行目标"]')!.value).toBe("@container:my-web")
  })

  test("写错的目标失焦后才标红并给一句话", async () => {
    await act(async () => root.render(<Harness initial={[newRule("outbound", "@nope")]} onRules={() => {}} />))
    expect(container.textContent).not.toContain("不认识的对象")
    const input = container.querySelector<HTMLInputElement>('input[aria-label="出站规则第 1 行目标"]')!
    await act(async () => {
      input.focus()
      input.blur()
    })
    expect(container.textContent).toContain("不认识的对象 @nope")
  })

  test("非自定义模式下的“允许 @any”标出下面的规则不会生效", async () => {
    await act(async () => root.render(<Harness initial={[newRule("outbound", "@any")]} onRules={() => {}} />))
    expect(container.textContent).toContain("下面的规则不会生效")
  })
})
