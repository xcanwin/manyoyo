import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useFadingPill } from "./use-fading-pill"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
const probe = {} as { api: ReturnType<typeof useFadingPill> }
function Probe({ active }: { active: boolean }) {
  const api = useFadingPill(active)
  React.useEffect(() => {
    probe.api = api
  })
  return null
}
const render = (active: boolean) => act(async () => root.render(<Probe active={active} />))
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  vi.useFakeTimers()
  root = createRoot(document.createElement("div"))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})

describe("浮钮 3 秒内逐渐消失", () => {
  test("出现时开始淡出（fading），3 秒后不再显示", async () => {
    await render(true)
    expect(probe.api.visible).toBe(true)
    expect(probe.api.fading).toBe(true)
    await advance(2900)
    expect(probe.api.visible).toBe(true)
    await advance(200)
    expect(probe.api.visible).toBe(false)
  })

  test("条件不成立时不显示", async () => {
    await render(false)
    expect(probe.api.visible).toBe(false)
    await render(true)
    expect(probe.api.visible).toBe(true)
    await render(false)
    expect(probe.api.visible).toBe(false)
  })

  test("消失后用户再滚动（poke）：重新出现、淡出从头开始（cycle 变了）；条件不成立时 poke 无效", async () => {
    await render(true)
    const first = probe.api.cycle
    await advance(3100)
    expect(probe.api.visible).toBe(false)
    await act(async () => probe.api.poke())
    expect(probe.api.visible).toBe(true)
    expect(probe.api.cycle).not.toBe(first)
    await advance(3100)
    expect(probe.api.visible).toBe(false)
    await render(false)
    await act(async () => probe.api.poke())
    expect(probe.api.visible).toBe(false)
  })

  test("按住时保持全显、不淡出，松开后重新从头淡出（准备点击的一瞬间不会消失）", async () => {
    await render(true)
    await advance(2000)
    await act(async () => probe.api.hold(true))
    expect(probe.api.visible).toBe(true)
    expect(probe.api.fading).toBe(false)
    await advance(10000)
    expect(probe.api.visible).toBe(true)
    await act(async () => probe.api.hold(false))
    expect(probe.api.fading).toBe(true)
    await advance(2900)
    expect(probe.api.visible).toBe(true)
    await advance(200)
    expect(probe.api.visible).toBe(false)
  })

  test("按下时不换 cycle（换 key 会让按钮在按下和松开之间被换掉，点击就失效了）", async () => {
    await render(true)
    const before = probe.api.cycle
    await act(async () => probe.api.hold(true))
    expect(probe.api.cycle).toBe(before)
  })

  test("手指松开（hold(false)）不换 cycle：手机上 pointerup 后按钮被换掉，click 落空要点两次", async () => {
    await render(true)
    await act(async () => probe.api.hold(true))
    const before = probe.api.cycle
    await act(async () => probe.api.hold(false))
    expect(probe.api.cycle).toBe(before)
    expect(probe.api.fading).toBe(true)
  })

  test("按住时点了一下、按钮随即隐藏（收不到“松开 / 离开”）：下次出现照常淡出消失", async () => {
    await render(true)
    await act(async () => probe.api.hold(true))
    await render(false)
    await render(true)
    expect(probe.api.fading).toBe(true)
    await advance(3100)
    expect(probe.api.visible).toBe(false)
  })
})
