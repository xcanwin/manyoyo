import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { useIsMobile } from "@/hooks/use-mobile"
import type { SessionSummary } from "@/lib/api"
import { canConnectTerminal, createResizeReporter, type ResizeReporter } from "@/lib/terminal-resize"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Hint } from "@/components/hint"
import { Input } from "@/components/ui/input"

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

// 终端整块面板（含上下两条工具栏）是固定深色的，和应用的亮/暗主题无关——
// 终端本来就该长这样，跟着变浅反而和里面 CLI 自己输出的 ANSI 配色打架。
// 但前景色/光标/选区必须显式给：只设 background 的话这三样走 xterm 默认值，
// 选中文字时的高亮尤其容易和背景糊在一起看不出选了什么
const TERMINAL_THEME = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#fafafa",
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f46",
} as const

const KEYBAR_KEYS: Array<{ label: string; data: string }> = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "◀", data: "\x1b[D" },
  { label: "▲", data: "\x1b[A" },
  { label: "▼", data: "\x1b[B" },
  { label: "▶", data: "\x1b[C" },
  { label: "^C", data: "\x03" },
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
  // 手机上可点区域至少 40px（STYLE.md 第 12 节）
  const keySize = isMobile ? "lg" : "sm"
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

  // 仅历史会话没有可交互容器，
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

  // 移动端点按键条不改变焦点（输入条已聚焦就保持，没聚焦也不去聚焦）
  function keepFocus(event: React.MouseEvent) {
    if (isMobile) event.preventDefault()
  }

  function sendKey(data: string) {
    sendInput(data)
    // 桌面端：点击按钮会把浏览器焦点带到按钮本身，点完抢回给 xterm。
    // 移动端不抢：抢回输入条会弹出软键盘，挡住终端，也没法连续点方向键 / ctrl+c
    if (!isMobile) restoreFocus()
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
      theme: TERMINAL_THEME,
    })
    const sessionName = session.name
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term

    let socket: WebSocket | null = null
    let keepAliveTimer = 0
    let reporter: ResizeReporter | null = null

    // 容器尺寸为 0（标签页隐藏）时量不出列数，先不建连；等第一次拿到实际尺寸、
    // fit 完成后再连，保证初始列数就是对的
    function connect() {
      fitAddon.fit()
      const cols = Math.max(term.cols || DEFAULT_COLS, MIN_COLS)
      const rows = Math.max(term.rows || DEFAULT_ROWS, MIN_ROWS)
      setStatus("连接中...")
      setDisconnected(false)
      const ws = new WebSocket(buildTerminalWsUrl(sessionName, cols, rows))
      socket = ws
      socketRef.current = ws
      reporter = createResizeReporter({ cols, rows }, (c, r) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        ws.send(JSON.stringify({ type: "resize", cols: c, rows: r }))
        return true
      })

      keepAliveTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }))
        }
      }, KEEPALIVE_MS)

      ws.onopen = () => {
        // 连接建立前网页列数可能又变过：补报一次
        reporter?.report(term.cols, term.rows)
      }
      ws.onmessage = (event) => {
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
      ws.onclose = () => {
        window.clearInterval(keepAliveTimer)
        setStatus("连接已断开")
        setDisconnected(true)
      }
      ws.onerror = () => {
        setStatus("连接出错")
        setDisconnected(true)
      }
    }

    // fit 之后列数/行数变了就上报（防抖在 reporter 里），容器里的终端宽度才跟得上
    const resizeDisposable = term.onResize(({ cols, rows }) => reporter?.report(cols, rows))

    const dataDisposable = term.onData((data) => {
      if (!data || !socket || socket.readyState !== WebSocket.OPEN) return
      const send = applyModifiers(data, ctrlModeRef.current, altModeRef.current)
      socket.send(JSON.stringify({ type: "input", data: send }))
    })

    if (canConnectTerminal(container.clientWidth, container.clientHeight)) {
      connect()
    } else {
      setStatus("等待显示...")
    }

    let resizeTimer = 0
    const handleResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        // 切到其它标签页时终端是 display:none（尺寸为 0），此时 fit() 会按 0
        // 尺寸重排，切回来就是一屏错位的内容；等有实际尺寸了再量
        if (!canConnectTerminal(container.clientWidth, container.clientHeight)) return
        if (!socket) {
          connect()
          return
        }
        fitAddon.fit()
      }, RESIZE_DEBOUNCE_MS)
    }
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      window.clearTimeout(resizeTimer)
      window.clearInterval(keepAliveTimer)
      reporter?.dispose()
      resizeDisposable.dispose()
      dataDisposable.dispose()
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        // CONNECTING 时 send 会抛 InvalidStateError，只在已打开时通知服务端
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }))
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
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>请先在左侧选择一个容器 / AGENT</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  if (historyOnly) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>容器不可用</EmptyTitle>
          <EmptyDescription>当前会话只有历史记录，没有可访问的运行中容器，无法连接终端。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2">
        {/* 按钮组自己横向滚动，避免窄屏下被裁切导致 ctrl/alt 无法点击；
            状态文案放在同一行的右侧，省掉单独一行 */}
        <div className="flex min-w-0 gap-2 overflow-x-auto">
          {KEYBAR_KEYS.map((key) => (
            <Button
              key={key.label}
              type="button"
              variant="outline"
              size={keySize}
              onMouseDown={keepFocus}
              onClick={() => sendKey(key.data)}
              className="shrink-0 font-mono"
            >
              {key.label}
            </Button>
          ))}
          <Button
            type="button"
            variant={ctrlMode ? "default" : "outline"}
            size={keySize}
            aria-pressed={ctrlMode}
            onMouseDown={keepFocus}
            onClick={() => {
              setCtrlMode((value) => !value)
              if (!isMobile) termRef.current?.focus()
            }}
            className="shrink-0 font-mono"
          >
            ctrl
          </Button>
          <Button
            type="button"
            variant={altMode ? "default" : "outline"}
            size={keySize}
            aria-pressed={altMode}
            onMouseDown={keepFocus}
            onClick={() => {
              setAltMode((value) => !value)
              if (!isMobile) termRef.current?.focus()
            }}
            className="shrink-0 font-mono"
          >
            alt
          </Button>
        </div>
        <Hint className="shrink-0 truncate px-1">{status}</Hint>
        {disconnected ? (
          <Button type="button" variant="outline" size={keySize} onClick={() => setConnectSeq((value) => value + 1)} className="shrink-0">
            重连
          </Button>
        ) : null}
      </div>
      {/* 内边距放在外层，终端容器自身不留内边距：fit 按容器实际高度取整行数，
          上下的黑边才稳定，不会因为取整把底部余量吃掉 */}
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
        />
      </div>
      {isMobile ? (
        <form
          className="flex shrink-0 items-center gap-2 border-t bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          onSubmit={(event) => {
            event.preventDefault()
            submitMobileInput()
          }}
        >
          <Input
            ref={mobileInputRef}
            value={mobileInput}
            onChange={(event) => setMobileInput(event.target.value)}
            placeholder="输入内容，回车发送"
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" className="shrink-0">
            发送
          </Button>
        </form>
      ) : null}
    </div>
  )
}
