// 同步请求的调度：什么时候发、同一时间只发一个、主动触发不丢

const SYNC_FOCUSED_MS = 6000
const SYNC_UNFOCUSED_MS = 30000
const SYNC_IDLE_TIMEOUT_MS = 10 * 60 * 1000

// 返回距离下一次同步的毫秒数；null 表示暂停（页面隐藏，或空闲超过 10 分钟）。
// 窗口被别的软件挡住时 visibilityState 往往仍是 visible，所以没有焦点时降到 30 秒
export function decideSyncDelay(state: { visible: boolean; focused: boolean; idleMs: number }): number | null {
  if (!state.visible) return null
  if (state.idleMs > SYNC_IDLE_TIMEOUT_MS) return null
  return state.focused ? SYNC_FOCUSED_MS : SYNC_UNFOCUSED_MS
}

export type SingleFlight = {
  // manual=false（定时触发）：已有请求在路上就跳过；
  // manual=true（发送结束、停止、切回页面）：已有请求在路上时记一笔，结束后补跑恰好一次——
  // 只跳过不补会漏掉“流结束后立刻对账”那一次
  run: (manual: boolean) => Promise<void>
  // 取消在途请求（切换会话时），不补跑；之后可立刻重新 run
  abort: () => void
}

export function createSingleFlight(fn: (signal: AbortSignal) => Promise<unknown>): SingleFlight {
  let active: object | null = null
  let controller: AbortController | null = null
  let inflight: Promise<void> = Promise.resolve()
  let rerun = false

  function launch(): Promise<void> {
    const token = {}
    const c = new AbortController()
    active = token
    controller = c
    let started: Promise<unknown>
    try {
      started = Promise.resolve(fn(c.signal))
    } catch (error) {
      started = Promise.reject(error)
    }
    const p: Promise<void> = started
      .catch(() => {})
      .then(() => {
        // 已被 abort 脱钩的旧请求，结束后什么都不做
        if (active !== token) return
        active = null
        controller = null
        if (rerun) {
          rerun = false
          return launch()
        }
      })
    inflight = p
    return p
  }

  return {
    run(manual) {
      if (active) {
        if (manual) rerun = true
        return inflight
      }
      return launch()
    },
    abort() {
      controller?.abort()
      controller = null
      active = null
      rerun = false
    },
  }
}

// 窗口内的重复触发只执行一次（切回页面时 visibilitychange 与 focus 几乎同时到）
export function createCoalescer(windowMs: number, handler: () => void, now: () => number = Date.now): () => void {
  let last = -Infinity
  return () => {
    const t = now()
    if (t - last < windowMs) return
    last = t
    handler()
  }
}
