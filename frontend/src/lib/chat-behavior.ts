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

// 消息流的滚动规则：默认固定不动，新内容只往下追加；只有两种情况跟随——
// 1. 视野底部贴着内容底部（一开始没滑过、或滑到了最底）：继续贴底；
// 2. 视野底部贴着最新一段执行过程的底部（一般是点了“对齐到底部”）：让这段过程的底部一直贴着。
// “贴着”只容许 2px 的取整误差：离底部还差几十像素，说明用户正在看上面的内容，不能被拉走
export type ScrollAnchor = "bottom" | "trace" | "none"
const ANCHOR_TOLERANCE_PX = 2

export function computeScrollAnchor(params: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  // 最新一段（已展开的）执行过程的底部，在滚动内容坐标系里的位置；没有就是 null
  traceBottom: number | null
}): ScrollAnchor {
  const viewBottom = params.scrollTop + params.clientHeight
  if (viewBottom >= params.scrollHeight - ANCHOR_TOLERANCE_PX) return "bottom"
  if (params.traceBottom !== null && Math.abs(viewBottom - params.traceBottom) <= ANCHOR_TOLERANCE_PX) return "trace"
  return "none"
}

export function anchoredScrollTop(
  anchor: ScrollAnchor,
  params: { scrollHeight: number; clientHeight: number; traceBottom: number | null }
): number | null {
  if (anchor === "bottom") return Math.max(0, params.scrollHeight - params.clientHeight)
  if (anchor === "trace" && params.traceBottom !== null) return Math.max(0, params.traceBottom - params.clientHeight)
  return null
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
