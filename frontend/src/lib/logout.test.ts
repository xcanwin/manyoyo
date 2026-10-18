import { describe, expect, test, vi } from "vitest"

import { performLogout } from "./logout"

const deps = (overrides: Partial<Parameters<typeof performLogout>[0]> = {}) => ({
  pendingCount: 0,
  confirm: vi.fn(async () => true),
  post: vi.fn(async () => ({})),
  clear: vi.fn(),
  navigate: vi.fn(),
  ...overrides,
})

describe("退出登录", () => {
  test("确认后调用登出接口、清空本机草稿、回到登录页", async () => {
    const d = deps()
    expect(await performLogout(d)).toBe(true)
    expect(d.post).toHaveBeenCalledWith("/auth/logout")
    expect(d.clear).toHaveBeenCalled()
    expect(d.navigate).toHaveBeenCalledWith("/auth/login")
  })
  test("取消就什么都不做", async () => {
    const d = deps({ confirm: vi.fn(async () => false) })
    expect(await performLogout(d)).toBe(false)
    expect(d.post).not.toHaveBeenCalled()
    expect(d.clear).not.toHaveBeenCalled()
  })
  test("接口失败也清空草稿；有未确认送达的内容时在提示里写明条数", async () => {
    const confirm = vi.fn(async (options: { message: string }) => Boolean(options))
    const d = deps({ pendingCount: 2, confirm, post: vi.fn(async () => { throw new Error("offline") }) })
    await performLogout(d)
    expect(d.clear).toHaveBeenCalled()
    expect(confirm.mock.calls[0][0].message).toContain("还有 2 条没确认送达")
  })
})
