import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { UpdateBanner } from "@/components/update-banner"
import * as updateApi from "@/lib/update"

vi.mock("@/lib/update", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/update")>()
  return { ...original, fetchUpdateInfo: vi.fn() }
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.mocked(updateApi)
let container: HTMLDivElement
let root: Root

const available = { enabled: true, installMode: "offline", current: "7.1.6", latest: "8.0.0", updateAvailable: true, checkedAt: null, error: "" }

async function mount() {
  await act(async () => {
    root.render(<UpdateBanner />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("UpdateBanner", () => {
  test("shows the new version and the command to run", async () => {
    api.fetchUpdateInfo.mockResolvedValue(available)
    await mount()
    const banner = container.querySelector('[data-testid="update-banner"]')
    expect(banner?.textContent).toContain("8.0.0")
    expect(banner?.textContent).toContain("manyoyo update")
  })

  test("dismissing hides it and remembers the version, so a reload stays quiet", async () => {
    api.fetchUpdateInfo.mockResolvedValue(available)
    await mount()
    await act(async () => {
      ;(container.querySelector('button[aria-label="知道了"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull()
    expect(window.localStorage.getItem(updateApi.DISMISS_KEY)).toBe("8.0.0")

    await act(async () => root.unmount())
    root = createRoot(container)
    await mount()
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull()
  })

  test("renders nothing when up to date, disabled, or the check fails", async () => {
    api.fetchUpdateInfo.mockResolvedValue({ ...available, updateAvailable: false })
    await mount()
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull()

    api.fetchUpdateInfo.mockResolvedValue({ ...available, enabled: false })
    await mount()
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull()

    api.fetchUpdateInfo.mockRejectedValue(new Error("boom"))
    await mount()
    expect(container.querySelector('[data-testid="update-banner"]')).toBeNull()
  })
})
