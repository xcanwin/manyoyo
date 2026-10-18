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

// 滚动事件是不是我们自己补滚动引起的：设置 scrollTop 后浏览器到下一帧才派发滚动事件，
// 这期间视野可能又变矮（快速输入多行时输入框连续变高），按新尺寸判断会误判成“不贴底”、从此不再跟随。
// 位置等于上次自己设置的值，就当作自己引起的，不重新判断
export function isOwnScroll(scrollTop: number, lastProgrammaticTop: number | null): boolean {
  return lastProgrammaticTop !== null && Math.abs(scrollTop - lastProgrammaticTop) < 1
}

// 跟随的暂停只给“用户正在滚动”：滚轮、触摸、按键，以及点在滚动条上（目标是滚动容器本身）。
// 普通点击（展开一行、点按钮、点空白处）不暂停——旧逻辑把点击也算进去，点完 1.5 秒内来的新内容
// 会让锚点被重新判断成“不贴着”，从此不再跟随（点了“对齐到底部”仍不贴底就是这个原因）
const FOLLOW_PAUSE_MS = 1500

export function isScrollInput(type: "wheel" | "touch" | "key" | "pointer", onScroller: boolean): boolean {
  return type !== "pointer" || onScroller
}

// 暂停期间内容变化既不补滚动、也不重新判断锚点；锚点只在滚动事件里判断
export function isFollowPaused(params: { now: number; lastScrollInputAt: number; hasSelection: boolean }): boolean {
  return params.hasSelection || params.now - params.lastScrollInputAt < FOLLOW_PAUSE_MS
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

// “↓ 有新输出”浮钮是否显示：视野离底部超过一屏的 48px 阈值、而且内容变高了才出现；
// 回到底部附近就消失；内容没变化时保持原状（ResizeObserver 也会因为视野尺寸变化回调）
export function nextHasNewBelow(
  prev: boolean,
  m: { prevHeight: number; scrollHeight: number; scrollTop: number; clientHeight: number }
): boolean {
  if (isNearBottom(m.scrollTop, m.scrollHeight, m.clientHeight)) return false
  if (m.scrollHeight > m.prevHeight + 1) return true
  return prev
}
