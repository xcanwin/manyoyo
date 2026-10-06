import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DeniedList } from "@/components/container-manage/denied-list"
import type { DeniedRecord } from "@/lib/container-manage"

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

const rec = (host: string, background = false): DeniedRecord => ({ host, port: 443, count: 3, last: "2026-10-06T10:00:00.000Z", reason: "domain", background })

describe("DeniedList", () => {
  test("空状态显示「暂无」", async () => {
    await act(async () => root.render(<DeniedList denied={[]} disabled={false} onAllow={() => {}} />))
    expect(container.textContent).toContain("暂无")
  })

  test("普通域名直接列出，浏览器后台请求折叠成一组；点「允许」带上域名", async () => {
    const onAllow = vi.fn()
    await act(async () =>
      root.render(<DeniedList denied={[rec("pss.bdstatic.com"), rec("www.google.com", true)]} disabled={false} onAllow={onAllow} />)
    )
    expect(container.textContent).toContain("pss.bdstatic.com")
    expect(container.textContent).toContain("浏览器后台请求（1）")
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "允许")!
    await act(async () => button.click())
    expect(onAllow).toHaveBeenCalledWith("pss.bdstatic.com")
  })

  test("disabled 时「允许」不可点", async () => {
    await act(async () => root.render(<DeniedList denied={[rec("a.example.com")]} disabled onAllow={() => {}} />))
    expect((Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "允许") as HTMLButtonElement).disabled).toBe(true)
  })
})
