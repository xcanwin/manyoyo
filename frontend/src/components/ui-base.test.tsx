import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Hint } from "@/components/hint"
import { KeyValueList } from "@/components/key-value-list"
import { PageHeader } from "@/components/page-header"
import { StickyFooter } from "@/components/sticky-footer"

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
  document.body.innerHTML = ""
})
const render = (node: React.ReactNode) => act(async () => root.render(node))

describe("DialogContent size", () => {
  const popup = () => document.querySelector('[data-slot="dialog-content"]') as HTMLElement
  const open = async (size?: "sm" | "md" | "lg" | "wide") => {
    await render(
      <Dialog open>
        <DialogContent size={size}>
          <DialogTitle>标题</DialogTitle>
          <DialogDescription>说明</DialogDescription>
          <DialogBody>主体</DialogBody>
        </DialogContent>
      </Dialog>
    )
  }

  test.each([
    ["sm", "sm:max-w-sm"],
    ["md", "sm:max-w-md"],
    [undefined, "sm:max-w-md"],
    ["lg", "md:max-w-xl"],
    ["wide", "md:max-w-[min(96vw,80rem)]"],
  ] as const)("size=%s → %s", async (size, expected) => {
    await open(size)
    expect(popup().className).toContain(expected)
    expect(popup().getAttribute("data-size")).toBe(size ?? "md")
  })

  test("lg / wide 手机全屏，wide 桌面固定高度；sm / md 手机居中留边", async () => {
    await open("wide")
    expect(popup().className).toContain("max-md:h-dvh")
    expect(popup().className).toContain("md:h-[85dvh]")
    expect(popup().className).toContain("max-md:rounded-none")
    await open("sm")
    expect(popup().className).not.toContain("max-md:h-dvh")
    expect(popup().className).toContain("max-w-[calc(100%-2rem)]")
  })

  test("DialogBody 只让主体滚动", async () => {
    await open("lg")
    expect(document.querySelector('[data-slot="dialog-body"]')!.className).toContain("overflow-y-auto")
  })

  test("嵌套时渲染两层遮罩，被盖住的父弹窗带缩放 / 变暗的标记", async () => {
    await render(
      <Dialog open>
        <DialogContent size="wide">
          <DialogTitle>父</DialogTitle>
          <Dialog open>
            <DialogContent size="lg">
              <DialogTitle>子</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    )
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(2)
    const popups = Array.from(document.querySelectorAll('[data-slot="dialog-content"]'))
    expect(popups).toHaveLength(2)
    const parent = popups.find((p) => p.getAttribute("data-size") === "wide") as HTMLElement
    expect(parent.hasAttribute("data-nested-dialog-open")).toBe(true)
    expect(parent.className).toContain("data-nested-dialog-open:scale-[0.97]")
    expect(parent.className).toContain("data-nested-dialog-open:brightness-75")
  })
})

describe("基础组件", () => {
  test("Hint：辅助档，mono 加等宽", async () => {
    await render(<Hint mono>key</Hint>)
    const el = container.querySelector('[data-slot="hint"]')!
    expect(el.className).toContain("text-xs")
    expect(el.className).toContain("text-muted-foreground")
    expect(el.className).toContain("font-mono")
  })

  test("KeyValueList：桌面两列、手机单列，标签辅助档、值正文", async () => {
    await render(<KeyValueList items={[{ label: "名称", value: "alpha" }, { label: "路径", value: "/x", detail: "说明" }]} />)
    const list = container.querySelector("dl")!
    expect(list.className).toContain("grid-cols-1")
    expect(list.className).toContain("md:grid-cols-2")
    expect(Array.from(list.querySelectorAll("dt")).map((n) => n.textContent)).toEqual(["名称", "路径"])
    expect(list.textContent).toContain("说明")
  })

  test("StickyFooter：吸底并避让安全区", async () => {
    await render(<StickyFooter>保存</StickyFooter>)
    const el = container.querySelector('[data-slot="sticky-footer"]')!
    expect(el.className).toContain("sticky")
    expect(el.className).toContain("env(safe-area-inset-bottom)")
  })

  test("PageHeader：整页版有标题 + 说明 + 操作；compact 是 40px 工具栏", async () => {
    await render(<PageHeader title="标题" description="说明" actions={<button>操作</button>} />)
    expect(container.querySelector("h1")!.textContent).toBe("标题")
    expect(container.textContent).toContain("说明")
    expect(container.textContent).toContain("操作")
    await render(<PageHeader compact title="工具栏" />)
    const el = container.querySelector('[data-slot="page-header"]') as HTMLElement
    expect(el.hasAttribute("data-compact")).toBe(true)
    expect(el.className).toContain("h-10")
    expect(el.className).toContain("border-b")
  })
})

describe("FieldLegend 字重", () => {
  test("label 档是 14px / 600", async () => {
    const { FieldLegend, FieldSet } = await import("@/components/ui/field")
    await render(
      <FieldSet>
        <FieldLegend variant="label">分节</FieldLegend>
      </FieldSet>
    )
    const legend = document.querySelector('[data-slot="field-legend"]') as HTMLElement
    expect(legend.className).toContain("data-[variant=label]:text-sm")
    expect(legend.className).toContain("data-[variant=label]:font-semibold")
  })
})

describe("嵌套弹窗：点遮罩 / 按 Esc 只关最上面一层", () => {
  function Nested() {
    const [outer, setOuter] = React.useState(true)
    const [inner, setInner] = React.useState(true)
    return (
      <>
        <span data-testid="state">{`${outer ? "outer" : ""}|${inner ? "inner" : ""}`}</span>
        <Dialog open={outer} onOpenChange={setOuter}>
          <DialogContent>
            <DialogTitle>外层</DialogTitle>
            <DialogDescription>外层说明</DialogDescription>
            <Dialog open={inner} onOpenChange={setInner}>
              <DialogContent size="sm">
                <DialogTitle>内层</DialogTitle>
                <DialogDescription>内层说明</DialogDescription>
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  const state = () => document.querySelector('[data-testid="state"]')!.textContent
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  const press = (target: Element) => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }))
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }))
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }))
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }))
  }

  test("两层打开 → 点遮罩 → 只剩外层", async () => {
    await render(<Nested />)
    expect(state()).toBe("outer|inner")
    const backdrops = document.querySelectorAll('[data-slot="dialog-overlay"]')
    expect(backdrops.length).toBe(2)
    await act(async () => press(backdrops[backdrops.length - 1]))
    await flush()
    expect(state()).toBe("outer|")
  })

  test("两层打开 → 按 Esc → 只剩外层；再按一次才关外层", async () => {
    await render(<Nested />)
    const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await act(async () => esc())
    await flush()
    expect(state()).toBe("outer|")
    await act(async () => esc())
    await flush()
    expect(state()).toBe("|")
  })
})
