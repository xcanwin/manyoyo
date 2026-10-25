import * as React from "react"
import { Hint } from "@/components/hint"
import { FileIcon, FolderIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { apiGet, type SessionSummary } from "@/lib/api"
import { applySuggestion, parseSuggestTrigger, type SuggestTrigger } from "@/lib/composer-suggest"

type Item = { key: string; label: string; detail?: string; kind: "command" | "directory" | "file"; insert: string }

const MENTION_DEBOUNCE_MS = 150
const MENTION_LIMIT = 50

// 斜杠命令列表按会话缓存：同一会话里只请求一次（服务端从最近一次运行的 init 里记下，只列实测可用的）
const slashCache = new Map<string, string[]>()

// 输入框补全：开头打 “/” 列出可用的斜杠命令（目前只有 claude 有），打 “@” 列出工作目录里的文件。
// 弹层显示在输入框上方，焦点一直留在输入框里：↑↓ 选择、Enter / Tab 确认、Esc 关闭。输入法组词期间不触发
export function useComposerSuggestions({
  session,
  enabled,
  draft,
  onDraftChange,
  textareaRef,
}: {
  session: SessionSummary | null
  enabled: boolean
  draft: string
  onDraftChange: (value: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [caret, setCaret] = React.useState(0)
  const [composing, setComposing] = React.useState(false)
  // 候选按“是哪个触发”记下：触发变了而新结果还没回来时不显示旧候选（否则防抖期间按 Enter 会用旧候选替换）
  const [result, setResult] = React.useState<{ key: string; items: Item[] }>({ key: "", items: [] })
  const [activeIndex, setActiveIndex] = React.useState(0)
  // 用户按了 Esc：同一个触发位置不再弹出，直到触发位置变化
  const [dismissedAt, setDismissedAt] = React.useState<number | null>(null)

  const trigger: SuggestTrigger | null = React.useMemo(() => {
    if (!enabled || composing || !session) return null
    const parsed = parseSuggestTrigger(draft, caret)
    if (!parsed || parsed.start === dismissedAt) return null
    if (parsed.kind === "slash" && session.agentProgram !== "claude") return null
    return parsed
  }, [enabled, composing, session, draft, caret, dismissedAt])

  const sessionName = session?.name ?? ""
  const containerPath = session?.containerPath || "/"
  const triggerKey = trigger ? (trigger.kind === "slash" ? `slash:${trigger.query}` : `mention:${trigger.dir}:${trigger.prefix}`) : ""

  React.useEffect(() => {
    if (!trigger || !sessionName) {
      return
    }
    let cancelled = false
    if (trigger.kind === "slash") {
      const show = (commands: string[]) => {
        if (cancelled) return
        const query = trigger.query.toLowerCase()
        // 名字以输入开头的排前面，其次是包含输入的
        const lower = (name: string) => name.toLowerCase()
        const matched = [
          ...commands.filter((name) => lower(name).startsWith(query)),
          ...commands.filter((name) => !lower(name).startsWith(query) && lower(name).includes(query)),
        ].slice(0, 50)
        setResult({ key: triggerKey, items: matched.map((name) => ({ key: name, label: `/${name}`, kind: "command", insert: `/${name} ` })) })
        setActiveIndex(0)
      }
      const cached = slashCache.get(sessionName)
      if (cached) {
        queueMicrotask(() => show(cached))
      } else {
        apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/slash-commands`)
          .then((data) => {
            const commands = Array.isArray(data.commands) ? (data.commands as string[]) : []
            // 还没跑过（列表为空）时不缓存：跑过一次之后再打 / 就能拿到
            if (commands.length) slashCache.set(sessionName, commands)
            show(commands)
          })
          .catch(() => show([]))
      }
      return () => {
        cancelled = true
      }
    }
    // @ 后面直接写绝对路径时按绝对路径列，否则相对工作目录
    const base = containerPath.replace(/\/$/, "")
    const dir = (trigger.dir.startsWith("/") ? trigger.dir : `${base}/${trigger.dir}`).replace(/\/$/, "") || "/"
    const timer = window.setTimeout(() => {
      apiGet(
        `/api/sessions/${encodeURIComponent(sessionName)}/fs/list?path=${encodeURIComponent(dir)}&prefix=${encodeURIComponent(trigger.prefix)}&limit=${MENTION_LIMIT}`
      )
        .then((data) => {
          if (cancelled) return
          const entries = Array.isArray(data.entries) ? (data.entries as { name: string; kind: string; symlinkTargetKind?: string }[]) : []
          setResult({
            key: triggerKey,
            items: entries.map((entry) => {
              const isDir = entry.kind === "directory" || entry.symlinkTargetKind === "directory"
              return {
                key: entry.name,
                label: entry.name,
                detail: trigger.dir,
                kind: isDir ? "directory" : "file",
                insert: isDir ? `@${trigger.dir}${entry.name}/` : `${trigger.dir}${entry.name} `,
              }
            }),
          })
          setActiveIndex(0)
        })
        .catch(() => {
          if (!cancelled) setResult({ key: triggerKey, items: [] })
        })
    }, MENTION_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // triggerKey 已经概括了 trigger 里会影响请求的部分
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey, sessionName, containerPath])

  const items = result.key === triggerKey ? result.items : []
  const open = Boolean(trigger) && items.length > 0

  function select(index: number) {
    const item = items[index]
    if (!item || !trigger) return
    const next = applySuggestion(draft, trigger, item.insert)
    onDraftChange(next.text)
    setCaret(next.caret)
    window.requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  // 返回 true 表示按键被补全弹层用掉了（调用方不要再当成发送 / 换行）
  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing) return false
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => (index + step + items.length) % items.length)
      return true
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault()
      select(activeIndex)
      return true
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setDismissedAt(trigger?.start ?? null)
      return true
    }
    return false
  }

  function syncCaret(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(event.currentTarget.selectionStart ?? 0)
    if (dismissedAt !== null && parseSuggestTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)?.start !== dismissedAt) {
      setDismissedAt(null)
    }
  }

  const textareaProps = {
    onSelect: syncCaret,
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      setComposing(false)
      setCaret(event.currentTarget.selectionStart ?? 0)
    },
  }

  const popup = open ? (
    <div
      role="listbox"
      aria-label={trigger?.kind === "slash" ? "斜杠命令" : "文件"}
      className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item, index) => {
        const Icon = item.kind === "command" ? null : item.kind === "directory" ? FolderIcon : FileIcon
        return (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // 用 mousedown 而不是 click：避免输入框先失焦
            onMouseDown={(event) => {
              event.preventDefault()
              select(index)
            }}
            onMouseEnter={() => setActiveIndex(index)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
              index === activeIndex && "bg-accent"
            )}
          >
            {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
            <span className="min-w-0 truncate font-mono">{item.label}</span>
            {item.detail ? <Hint className="ml-auto shrink-0 truncate">{item.detail}</Hint> : null}
          </button>
        )
      })}
    </div>
  ) : null

  // 内容一变就重新允许弹出（Esc 只关掉当前这一次）
  function handleInput(caretAt: number) {
    setCaret(caretAt)
    if (dismissedAt !== null) setDismissedAt(null)
  }

  return { open, popup, handleKeyDown, textareaProps, handleInput }
}
