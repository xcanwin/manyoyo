// 聊天界面用到的纯函数集合

// 判断滚动容器是否已经贴近底部（阈值内），用于决定新消息/流式增量是否要
// 跟着把滚动条带到底部
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  thresholdPx = 48
): boolean {
  const distance = scrollHeight - (scrollTop + clientHeight)
  return distance <= thresholdPx
}

// 内容更新后要不要把滚动条带到底部。只有同时满足才跟随：
// 1. 用户没往上翻过（stick）；2. 更新之前视野确实贴着底部——展开很长的执行过程后视野停在过程顶部，
// 没有任何滚动事件，stick 仍是 true，只看 stick 会被一次次拉到底（B1 的根因）；
// 3. 用户此刻没在滚轮 / 触摸 / 点击 / 选中文字
export function shouldFollowBottom(params: {
  stick: boolean
  scrollTop: number
  prevScrollHeight: number
  clientHeight: number
  interacting: boolean
  hasSelection: boolean
}): boolean {
  if (!params.stick || params.interacting || params.hasSelection) return false
  return isNearBottom(params.scrollTop, params.prevScrollHeight, params.clientHeight)
}

// 按当前 AGENT 名拼接页面标题，未传/空白时回退默认标题
export function buildDocumentTitle(agentName?: string | null): string {
  const trimmed = String(agentName || "").trim()
  return trimmed ? `${trimmed} · MANYOYO Web` : "MANYOYO Web"
}

// 消息气泡的显示状态。pending 只对服务端还没写完的 AGENT 回复有意义；
// user 消息在任务进行中也会被服务端存成 pending（运行锁依赖它），
// 但内容早已完整，不能因此变淡或丢掉复制按钮
export function getBubbleState(message: { role: string; content: string; pending?: boolean }): {
  faded: boolean
  copyable: boolean
} {
  const pending = message.role !== "user" && message.pending === true
  return { faded: pending, copyable: Boolean(message.content) && !pending }
}

// 滚到顶部附近自动加载更早的消息
export function shouldLoadEarlier(params: {
  scrollTop: number
  hasMore: boolean
  loading: boolean
  thresholdPx?: number
}): boolean {
  if (!params.hasMore || params.loading) return false
  return params.scrollTop <= (params.thresholdPx ?? 80)
}

// 前面插入更早的消息后，把滚动位置补上新增的高度，视野停在原来的内容上
export function computeScrollRestore(params: {
  prevScrollHeight: number
  nextScrollHeight: number
  scrollTop: number
}): number {
  return params.scrollTop + Math.max(0, params.nextScrollHeight - params.prevScrollHeight)
}
