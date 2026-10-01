import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { MirrorSettings } from "@/components/mirror-settings"
import type { MirrorPresets, Mirrors } from "@/lib/mirrors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const presets: MirrorPresets = {
  apt: [{ label: "阿里云", value: "https://mirrors.aliyun.com" }],
  npm: [{ label: "阿里云", value: "https://registry.npmmirror.com/" }],
  pip: [{ label: "清华", value: "https://pypi.tuna.tsinghua.edu.cn/simple" }],
}

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

function Harness({ initial, onChange }: { initial: Mirrors; onChange: (m: Mirrors) => void }) {
  const [mirrors, setMirrors] = React.useState(initial)
  return (
    <MirrorSettings
      mirrors={mirrors}
      presets={presets}
      onChange={(next) => {
        setMirrors(next)
        onChange(next)
      }}
    />
  )
}

const select = (tool: string) => container.querySelector(`#mirror-${tool}`) as HTMLSelectElement

async function choose(tool: string, value: string) {
  const el = select(tool)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("MirrorSettings", () => {
  test("defaults to the official source everywhere and shows no custom input", async () => {
    await act(async () => root.render(<Harness initial={{ apt: "", npm: "", pip: "" }} onChange={vi.fn()} />))
    for (const tool of ["apt", "npm", "pip"]) expect(select(tool).value).toBe("")
    expect(container.querySelector("input")).toBeNull()
    const options = Array.from(select("npm").options).map((o) => o.textContent)
    expect(options).toEqual(["官方默认", "阿里云", "自定义…"])
  })

  test("picking a preset reports its url; going back to official clears it", async () => {
    const onChange = vi.fn()
    await act(async () => root.render(<Harness initial={{ apt: "", npm: "", pip: "" }} onChange={onChange} />))
    await choose("npm", "https://registry.npmmirror.com/")
    expect(onChange).toHaveBeenLastCalledWith({ apt: "", npm: "https://registry.npmmirror.com/", pip: "" })
    await choose("npm", "")
    expect(onChange).toHaveBeenLastCalledWith({ apt: "", npm: "", pip: "" })
  })

  test("custom shows an input whose text is reported", async () => {
    const onChange = vi.fn()
    await act(async () => root.render(<Harness initial={{ apt: "", npm: "", pip: "" }} onChange={onChange} />))
    await choose("pip", "__custom__")
    const input = container.querySelector("#mirror-pip-custom") as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, "https://my.corp/pypi/simple")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({ apt: "", npm: "", pip: "https://my.corp/pypi/simple" })
  })

  test("an already configured preset or custom url is reflected on mount", async () => {
    await act(async () =>
      root.render(<Harness initial={{ apt: "https://mirrors.aliyun.com", npm: "", pip: "https://my.corp/simple" }} onChange={vi.fn()} />)
    )
    expect(select("apt").value).toBe("https://mirrors.aliyun.com")
    expect(select("pip").value).toBe("__custom__")
    expect((container.querySelector("#mirror-pip-custom") as HTMLInputElement).value).toBe("https://my.corp/simple")
  })
})
