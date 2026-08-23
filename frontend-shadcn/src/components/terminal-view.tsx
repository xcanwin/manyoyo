import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

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
  const [status, setStatus] = React.useState("")

  function sendKey(data: string) {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }))
    }
  }

  React.useEffect(() => {
    const container = containerRef.current
    if (!session || !container) return

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

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }))
      }
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
    }
  }, [session])

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-6 text-center text-sm text-zinc-400">
        请先在左侧选择一个容器 / AGENT
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs text-zinc-400">{status}</span>
        <div className="flex gap-1">
          {KEYBAR_KEYS.map((key) => (
            <button
              key={key.label}
              type="button"
              onClick={() => sendKey(key.data)}
              className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 p-2" />
    </div>
  )
}
