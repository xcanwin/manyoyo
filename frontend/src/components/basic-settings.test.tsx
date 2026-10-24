import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { BasicSettings } from "./basic-settings"

const apiGet = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), apiGet }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const IMAGES = {
  defaults: { imageName: "ghcr.io/xcanwin/manyoyo", imageVersion: "2.3.0-common" },
  images: [
    { name: "ghcr.io/xcanwin/manyoyo", tag: "2.3.0-common", id: "a", created: "2 days ago", size: "2.8GB" },
    { name: "ghcr.io/xcanwin/manyoyo", tag: "2.2.0-common", id: "b", created: "2 weeks ago", size: "2.79GB" },
    { name: "my/sandbox", tag: "1.0.0-full", id: "c", created: "1 hour ago", size: "3GB" },
  ],
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  apiGet.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function mount(liveParsed: Record<string, unknown>, images: unknown = IMAGES) {
  if (images === null) apiGet.mockRejectedValue(new Error("boom"))
  else apiGet.mockResolvedValue(images)
  const onCommit = vi.fn()
  await act(async () => root.render(<BasicSettings liveParsed={liveParsed} onCommit={onCommit} />))
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
  return onCommit
}
const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("系统设置 · 基础", () => {
  test("配置里一个都没写也有全部字段可填，占位符是默认值，不再是“暂无内容”", async () => {
    await mount({})
    expect(container.textContent).not.toContain("暂无内容")
    for (const id of ["containerName", "hostPath", "containerPath", "imageName"]) expect(input(`config-field-${id}`)).toBeTruthy()
    expect(input("config-field-imageName")!.placeholder).toBe("ghcr.io/xcanwin/manyoyo")
    expect(container.textContent).toContain("容器模式")
    expect(container.textContent).toContain("默认（2.3.0-common）")
  })

  test("填容器名 / 目录：按字段提交", async () => {
    const onCommit = await mount({})
    await type(input("config-field-hostPath")!, "/work/a")
    expect(onCommit).toHaveBeenLastCalledWith(["hostPath"], '"/work/a"', "/work/a")
  })

  test("镜像名有本机镜像候选；版本是下拉，只列所选镜像在本机有的版本", async () => {
    await mount({ imageName: "my/sandbox", imageVersion: "1.0.0-full" })
    const options = Array.from(container.querySelectorAll("#config-image-names option")).map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(["ghcr.io/xcanwin/manyoyo", "my/sandbox"])
    expect(container.querySelector("#config-field-imageVersion-select")).toBeTruthy()
    expect(container.querySelector("#config-field-imageVersion")).toBeNull()
    expect(container.textContent).toContain("1.0.0-full")
    expect(container.textContent).not.toContain("2.2.0-common")
  })

  test("把镜像名改成本机另一个镜像：版本联动换成它最新的版本，两个字段都提交", async () => {
    const onCommit = await mount({ imageName: "ghcr.io/xcanwin/manyoyo", imageVersion: "2.2.0-common" })
    await type(input("config-field-imageName")!, "my/sandbox")
    expect(onCommit).toHaveBeenCalledWith(["imageName"], '"my/sandbox"', "my/sandbox")
    expect(onCommit).toHaveBeenLastCalledWith(["imageVersion"], '"1.0.0-full"', "1.0.0-full")
  })

  test("输入本机没有的镜像名：不动版本，版本变成可直接填写的输入框", async () => {
    const onCommit = await mount({ imageName: "ghcr.io/xcanwin/manyoyo", imageVersion: "2.2.0-common" })
    await type(input("config-field-imageName")!, "not/pulled")
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(input("config-field-imageVersion")).toBeTruthy()
    await type(input("config-field-imageVersion")!, "9.9.9-common")
    expect(onCommit).toHaveBeenLastCalledWith(["imageVersion"], '"9.9.9-common"', "9.9.9-common")
  })

  test("配置里的版本本机没有：显示成输入框保留原值，不会被悄悄改掉", async () => {
    const onCommit = await mount({ imageName: "ghcr.io/xcanwin/manyoyo", imageVersion: "1.0.0-common" })
    expect(input("config-field-imageVersion")!.value).toBe("1.0.0-common")
    expect(onCommit).not.toHaveBeenCalled()
  })

  test("拿不到本机镜像列表：镜像名和版本都是普通输入框，照样能填", async () => {
    const onCommit = await mount({ imageVersion: "1.0.0-common" }, null)
    expect(input("config-field-imageVersion")!.value).toBe("1.0.0-common")
    await type(input("config-field-imageName")!, "x/y")
    expect(onCommit).toHaveBeenLastCalledWith(["imageName"], '"x/y"', "x/y")
  })
})
