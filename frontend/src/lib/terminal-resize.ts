// 终端宽度跟随：fit 之后列数/行数变了，要告诉服务端同步到容器里的终端，
// 否则网页这边的列数变了而容器那边没变，按整行宽度绘制的程序会超出被切掉

const MAX_COLS = 500
const MAX_ROWS = 200
export const RESIZE_REPORT_DEBOUNCE_MS = 150

// 容器尺寸为 0（标签页隐藏时是 display:none）时量不出列数，不能拿它去建连
export function canConnectTerminal(clientWidth: number, clientHeight: number): boolean {
  return clientWidth > 0 && clientHeight > 0
}

export function normalizeReportedSize(cols: number, rows: number): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null
  return { cols: Math.min(cols, MAX_COLS), rows: Math.min(rows, MAX_ROWS) }
}

export type ResizeReporter = {
  report: (cols: number, rows: number) => void
  dispose: () => void
}

// send 返回 true 表示已发出；连接还没打开时返回 false，不记为已发送，之后再 report 会重试
export function createResizeReporter(
  initial: { cols: number; rows: number },
  send: (cols: number, rows: number) => boolean,
  delayMs: number = RESIZE_REPORT_DEBOUNCE_MS
): ResizeReporter {
  let sent = { ...initial }
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    report(cols, rows) {
      const size = normalizeReportedSize(cols, rows)
      if (!size) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (size.cols === sent.cols && size.rows === sent.rows) return
        if (send(size.cols, size.rows)) sent = size
      }, delayMs)
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
