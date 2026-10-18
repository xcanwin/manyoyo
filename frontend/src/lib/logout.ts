// 退出登录的流程（抽出来便于测试）：先确认；确认后无论接口成败都清掉本机草稿再去登录页——
// 共用设备上“退出”最要紧的是本机不留内容，接口失败（比如已经过期）也不该把内容留下
export async function performLogout(deps: {
  pendingCount: number
  confirm: (options: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>
  post: (url: string) => Promise<unknown>
  clear: () => void
  navigate: (url: string) => void
}): Promise<boolean> {
  const proceed = await deps.confirm({
    title: "退出登录",
    message:
      "退出后，这台设备上没发送的草稿会被清空。" + (deps.pendingCount > 0 ? `还有 ${deps.pendingCount} 条没确认送达。` : ""),
    confirmLabel: "退出",
  })
  if (!proceed) return false
  try {
    await deps.post("/auth/logout")
  } catch {
    // 接口失败也继续清理
  } finally {
    deps.clear()
    deps.navigate("/auth/login")
  }
  return true
}
