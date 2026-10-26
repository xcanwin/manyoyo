// 刚新建的空会话（快捷对话、新建容器、新建 AGENT）：已知没有消息，
// 第一帧就按空会话渲染（输入框直接居中），不先用“加载中”占位再跳变。
// 分叉、/clear、复制容器带历史，不要登记。
const fresh = new Set<string>()

export function markFreshSession(name: string): void {
  fresh.add(name)
}

export function isFreshSession(name: string | undefined): boolean {
  return Boolean(name) && fresh.has(name as string)
}

// 仅供测试
export function resetFreshSessions(): void {
  fresh.clear()
}

// 底部输入框什么时候渲染：空会话时输入框在中间，创建中和首次加载（还不知道有没有消息）都不能先放在底部
export function showBottomComposer(state: { emptyConversation: boolean; creatingAgent: boolean; loadingFirst: boolean }): boolean {
  return !state.emptyConversation && !state.creatingAgent && !state.loadingFirst
}
