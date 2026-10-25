import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DirectoryPickerDialog } from "@/components/directory-picker-dialog"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let urls: string[]

beforeEach(() => {
  urls = []
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(decodeURIComponent(String(url)))
      if (String(url).includes("path=")) {
        return new Response(JSON.stringify({ error: "ENOENT: no such file or directory, lstat '/home/u/work/20261026'" }), { status: 400 })
      }
      return new Response(JSON.stringify({ currentPath: "/home/u", parentPath: "/home", entries: [{ name: "proj", path: "/home/u/proj" }] }))
    })
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

describe("选择目录弹窗", () => {
  test("初始目录不存在时回到主目录，不显示 ENOENT；并提醒选空白目录", async () => {
    await act(async () => root.render(<DirectoryPickerDialog open onOpenChange={() => {}} initialPath="/home/u/work/20261026" onSelect={() => {}} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(urls[0]).toContain("path=/home/u/work/20261026")
    expect(urls[1]).toBe("/api/fs/directories?")
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("ENOENT")
    expect(text).toContain("proj")
    expect((document.querySelector("input[readonly]") as HTMLInputElement).value).toBe("/home/u")
    expect(text).toContain("尽量新建一个空白目录并选择它，避免容器看到过多的宿主机文件")
  })

  test("在弹窗里点进一个不存在的目录仍然报错（不静默跳走）", async () => {
    await act(async () => root.render(<DirectoryPickerDialog open onOpenChange={() => {}} initialPath="" onSelect={() => {}} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const entry = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "proj")!
    await act(async () => entry.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(document.body.textContent).toContain("ENOENT")
  })
})
