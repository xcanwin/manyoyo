import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/utils"
import type { SessionSummary } from "@/lib/api"

const MIN_COLS = 40
const MIN_ROWS = 12
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 36
const RESIZE_DEBOUNCE_MS = 60

function buildTerminalWsUrl(sessionName: string, cols: number, rows: number): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionName)}/terminal/ws`,
    `${protocol}://${window.location.host}`
  )
  url.searchParams.set("cols", String(cols))
  url.searchParams.set("rows", String(rows))
  return url.toString()
}

const KEYBAR_KEYS: Array<{ label: string; data: string }> = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "◀", data: "\x1b[D" },
  { label: "▲", data: "\x1b[A" },
  { label: "▼", data: "\x1b[B" },
  { label: "▶", data: "\x1b[C" },
]

export function TerminalView({ session }: { session: SessionSummary | null }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const [status, setStatus] = React.useState("")
  const [ctrlMode, setCtrlMode] = React.useState(false)
  const [altMode, setAltMode] = React.useState(false)
  const ctrlModeRef = React.useRef(false)
  const altModeRef = React.useRef(false)
  React.useEffect(() => {
    ctrlModeRef.current = ctrlMode
  }, [ctrlMode])
  React.useEffect(() => {
    altModeRef.current = altMode
  }, [altMode])

  // 与旧版前端 isActiveSessionHistoryOnly 对齐：仅历史会话没有可交互容器，
  // 不应该自动建立终端连接（否则会静默触发后端新建容器）
  const historyOnly = session?.status === "history"

  function sendKey(data: string) {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }))
    }
    // 点击按钮会把浏览器焦点带到按钮本身，这里点完再抢回来，
    // 保证紧接着的物理键盘输入还能继续发到终端
    termRef.current?.focus()
  }

  React.useEffect(() => {
    const container = containerRef.current
    if (!session || !container || historyOnly) return

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#09090b" },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    termRef.current = term

    const cols = Math.max(term.cols || DEFAULT_COLS, MIN_COLS)
    const rows = Math.max(term.rows || DEFAULT_ROWS, MIN_ROWS)
    setStatus("连接中...")
    const socket = new WebSocket(buildTerminalWsUrl(session.name, cols, rows))
    socketRef.current = socket

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.type === "output") {
          term.write(payload.data)
        } else if (payload.type === "status") {
          if (payload.phase === "ready") setStatus("已连接")
          else if (payload.phase === "closed") setStatus("会话已结束")
        } else if (payload.type === "error") {
          term.write(`\r\n[error] ${payload.error}\r\n`)
        }
      } catch {
        // 忽略无法解析的消息
      }
    }
    socket.onclose = () => setStatus("连接已断开")
    socket.onerror = () => setStatus("连接出错")

    // 与旧版前端终端面板的 ctrl/alt 修饰键切换对齐：单字符输入时按当前修饰状态转换
    const dataDisposable = term.onData((data) => {
      if (!data || socket.readyState !== WebSocket.OPEN) return
      let send = data
      if (ctrlModeRef.current && data.length === 1) {
        const code = data.charCodeAt(0)
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          send = String.fromCharCode(code & 0x1f)
        }
      } else if (altModeRef.current && data.length === 1) {
        send = "\x1b" + data
      }
      socket.send(JSON.stringify({ type: "input", data: send }))
    })

    let resizeTimer = 0
    const handleResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => fitAddon.fit(), RESIZE_DEBOUNCE_MS)
    }
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      window.clearTimeout(resizeTimer)
      dataDisposable.dispose()
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.send(JSON.stringify({ type: "close" }))
        socket.close()
      }
      term.dispose()
      socketRef.current = null
      termRef.current = null
    }
    // 依赖 session?.name 而非整个 session 对象：会话列表刷新会产生新的 session
    // 对象引用（同一个会话名），若依赖整个对象会导致终端在正常刷新时被反复重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, historyOnly])

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-6 text-center text-sm text-zinc-400">
        请先在左侧选择一个容器 / AGENT
      </div>
    )
  }

  if (historyOnly) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 bg-zinc-950 p-6 text-center text-sm text-zinc-400">
        <p className="font-medium text-zinc-200">容器不可用</p>
        <p>当前会话只有历史记录，没有可访问的运行中容器，无法连接终端。</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5">
        {/* 按钮组自己横向滚动，避免窄屏下被裁切导致 ctrl/alt 无法点击；
            状态文案放在同一行的右侧，省掉单独一行 */}
        <div className="flex min-w-0 gap-1 overflow-x-auto">
          {KEYBAR_KEYS.map((key) => (
            <button
              key={key.label}
              type="button"
              onClick={() => sendKey(key.data)}
              className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {key.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setCtrlMode((value) => !value)
              termRef.current?.focus()
            }}
            className={cn(
              "shrink-0 rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-300 hover:bg-zinc-800",
              ctrlMode && "border-zinc-100 bg-zinc-100 text-zinc-900 hover:bg-zinc-100"
            )}
          >
            ctrl
          </button>
          <button
            type="button"
            onClick={() => {
              setAltMode((value) => !value)
              termRef.current?.focus()
            }}
            className={cn(
              "shrink-0 rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-300 hover:bg-zinc-800",
              altMode && "border-zinc-100 bg-zinc-100 text-zinc-900 hover:bg-zinc-100"
            )}
          >
            alt
          </button>
        </div>
        <span className="shrink-0 truncate px-1 text-xs text-zinc-400">{status}</span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 p-2" />
    </div>
  )
}
