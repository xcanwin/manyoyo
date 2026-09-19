import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import type { SessionSummary } from "@/lib/api"

const MIN_COLS = 40
const MIN_ROWS = 12
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 36
const RESIZE_DEBOUNCE_MS = 60
// 上行保活：服务端每 30s 发 ping 帧，浏览器自动回 pong，但那只覆盖下行；
// 浏览器 JS 发不出 ping 帧，所以这里用应用层消息给上行也制造流量，
// 周期取得比服务端略短，保证两个方向都不会闲到触发代理的空闲超时
const KEEPALIVE_MS = 25000

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

// 单字符输入按当前修饰键状态转换：ctrl 走控制字符，alt 走 ESC 前缀。
// 物理键盘（xterm onData）和移动端输入条共用同一套规则
function applyModifiers(data: string, ctrl: boolean, alt: boolean): string {
  if (data.length !== 1) return data
  if (ctrl) {
    const code = data.charCodeAt(0)
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return String.fromCharCode(code & 0x1f)
    }
    return data
  }
  if (alt) return "\x1b" + data
  return data
}

export function TerminalView({ session }: { session: SessionSummary | null }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const mobileInputRef = React.useRef<HTMLInputElement | null>(null)
  const isMobile = useIsMobile()
  const [status, setStatus] = React.useState("")
  const [disconnected, setDisconnected] = React.useState(false)
  // 重连只发生在用户点击时：重连意味着新开一个 shell（旧进程随连接关闭已被
  // 回收），静默自动重连会让用户以为还是原来那个 shell
  const [connectSeq, setConnectSeq] = React.useState(0)
  const [mobileInput, setMobileInput] = React.useState("")
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

  function sendInput(data: string) {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }))
    }
  }

  // 移动端的实际输入口是下方的输入条（xterm 的隐藏 textarea 被禁用了），
  // 焦点要还给它；桌面端仍然还给 xterm，保证物理键盘继续可用
  function restoreFocus() {
    if (isMobile) mobileInputRef.current?.focus()
    else termRef.current?.focus()
  }

  function sendKey(data: string) {
    sendInput(data)
    // 点击按钮会把浏览器焦点带到按钮本身，这里点完再抢回来
    restoreFocus()
  }

  function submitMobileInput() {
    if (mobileInput.length === 1 && (ctrlMode || altMode)) {
      // 修饰键组合（如 ctrl + c）是一个控制字符，不该再补回车
      sendInput(applyModifiers(mobileInput, ctrlMode, altMode))
    } else {
      // 空输入按发送等价于敲一次回车，用来确认 TUI 里的各种提示
      sendInput(mobileInput ? `${mobileInput}\r` : "\r")
    }
    setMobileInput("")
    mobileInputRef.current?.focus()
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
    setDisconnected(false)
    const socket = new WebSocket(buildTerminalWsUrl(session.name, cols, rows))
    socketRef.current = socket

    const keepAliveTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }))
      }
    }, KEEPALIVE_MS)

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
        // 其余类型（保活的 pong 等）不需要落到终端上
      } catch {
        // 忽略无法解析的消息
      }
    }
    socket.onclose = () => {
      window.clearInterval(keepAliveTimer)
      setStatus("连接已断开")
      setDisconnected(true)
    }
    socket.onerror = () => {
      setStatus("连接出错")
      setDisconnected(true)
    }

    // 与旧版前端终端面板的 ctrl/alt 修饰键切换对齐
    const dataDisposable = term.onData((data) => {
      if (!data || socket.readyState !== WebSocket.OPEN) return
      const send = applyModifiers(data, ctrlModeRef.current, altModeRef.current)
      socket.send(JSON.stringify({ type: "input", data: send }))
    })

    let resizeTimer = 0
    const handleResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        // 切到其它标签页时终端是 display:none（尺寸为 0），此时 fit() 会按 0
        // 尺寸重排，切回来就是一屏错位的内容；等有实际尺寸了再量
        if (!container.clientWidth || !container.clientHeight) return
        fitAddon.fit()
      }, RESIZE_DEBOUNCE_MS)
    }
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      window.clearTimeout(resizeTimer)
      window.clearInterval(keepAliveTimer)
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
  }, [session?.name, historyOnly, connectSeq])

  // 移动端禁掉 xterm 自己的隐藏 textarea：它接不住输入法的候选/联想（合成阶段
  // 的内容不会进 onData），表现就是键盘弹出来、打字却什么都不显示。改由下方的
  // 输入条承接输入，这里只负责不再唤起那个会吞字的键盘
  React.useEffect(() => {
    const textarea = containerRef.current?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea"
    )
    if (!textarea) return
    textarea.readOnly = isMobile
    if (isMobile) textarea.setAttribute("inputmode", "none")
    else textarea.removeAttribute("inputmode")
  }, [isMobile, session?.name, historyOnly, connectSeq])

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
        {disconnected ? (
          <button
            type="button"
            onClick={() => setConnectSeq((value) => value + 1)}
            className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            重连
          </button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 p-2"
        onClick={isMobile ? () => mobileInputRef.current?.focus() : undefined}
      />
      {isMobile ? (
        <form
          className="flex shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            submitMobileInput()
          }}
        >
          <input
            ref={mobileInputRef}
            value={mobileInput}
            onChange={(event) => setMobileInput(event.target.value)}
            placeholder="输入内容，回车发送"
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500"
          />
          <button
            type="submit"
            className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            发送
          </button>
        </form>
      ) : null}
    </div>
  )
}
