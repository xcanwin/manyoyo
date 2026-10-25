import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SideAnswer } from "@/components/side-answer"
import { useSideQuestion } from "@/hooks/use-side-question"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const api: { ask: ReturnType<typeof useSideQuestion>["ask"]; close: ReturnType<typeof useSideQuestion>["close"] } = {
  ask: async () => {},
  close: () => {},
}
let signals: AbortSignal[]
let respond: (() => Response) | null

function Harness({ active }: { active: string }) {
  const { state, ask, close } = useSideQuestion(active)
  // 测试夹具：把 hook 的方法交给测试代码（对象属性赋值不触发“渲染期重新赋值外部变量”规则）
  Object.assign(api, { ask, close })
  return state ? <SideAnswer state={state} onClose={close} sessionName={active} baseDir="/w" /> : <div>无</div>
}

beforeEach(() => {
  signals = []
  respond = null
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal)
      return new Promise<Response>((resolve, reject) => {
        ;(init!.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        if (respond) resolve(respond())
      })
    })
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("侧问浮层", () => {
  test("发问后显示加载中，答案回来后显示；关闭后消失", async () => {
    respond = () => new Response(JSON.stringify({ answer: "**ZEBRA**" }))
    await act(async () => root.render(<Harness active="demo" />))
    await act(async () => { await api.ask("demo", "秘密词是什么") })
    expect(container.textContent).toContain("侧问：秘密词是什么")
    expect(container.querySelector("strong")?.textContent).toBe("ZEBRA")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="关闭侧问"]')!.click())
    expect(container.textContent).toBe("无")
  })

  test("回答期间关闭：中止请求（服务端据此在容器里终止进程）", async () => {
    await act(async () => root.render(<Harness active="demo" />))
    let pending: Promise<void> | undefined
    await act(async () => { pending = api.ask("demo", "慢问题") })
    expect(container.textContent).toContain("正在回答，主任务不受影响")
    await act(async () => api.close())
    await pending
    expect(signals[0].aborted).toBe(true)
    expect(container.textContent).toBe("无")
  })

  test("换到别的会话：浮层清掉并中止", async () => {
    await act(async () => root.render(<Harness active="demo" />))
    await act(async () => { void api.ask("demo", "问") })
    await act(async () => root.render(<Harness active="other" />))
    expect(signals[0].aborted).toBe(true)
    expect(container.textContent).toBe("无")
  })

  test("出错显示错误文字", async () => {
    respond = () => new Response(JSON.stringify({ error: "上一个侧问还在回答，请稍等" }), { status: 409 })
    await act(async () => root.render(<Harness active="demo" />))
    await act(async () => { await api.ask("demo", "问") })
    expect(container.textContent).toContain("上一个侧问还在回答")
  })
})
