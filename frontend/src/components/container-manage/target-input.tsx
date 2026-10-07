import * as React from "react"

import { Input } from "@/components/ui/input"
import {
  type Candidate,
  type Direction,
  type PeerOption,
  containerRefToId,
  containerRefToName,
  describeTarget,
  targetCandidates,
} from "@/lib/container-manage"
import { cn } from "@/lib/utils"

function Highlight({ text, hit }: { text: string; hit: number[] }) {
  return (
    <>
      {[...text].map((char, i) =>
        hit.includes(i) ? (
          <mark key={i} className="bg-transparent font-bold text-inherit underline underline-offset-2">
            {char}
          </mark>
        ) : (
          <React.Fragment key={i}>{char}</React.Fragment>
        )
      )}
    </>
  )
}

// 目标 / 来源输入框：普通输入；输入 @ 弹出候选（预设对象、容器），子序列模糊匹配，↑↓ / Enter / Esc；
// 选中后交给 onPicked（规则表把焦点移到端口框）。存的是 id，显示的是名称。
export function TargetInput({
  value,
  onChange,
  direction,
  containers,
  invalid,
  placeholder,
  ariaLabel,
  onPicked,
  onBlurred,
}: {
  value: string
  onChange: (value: string) => void
  direction: Direction
  /** 不传表示容器列表未知（新建容器），不查容器是否存在 */
  containers?: PeerOption[]
  invalid?: boolean
  placeholder?: string
  ariaLabel: string
  onPicked?: () => void
  onBlurred?: () => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const shown = draft ?? containerRefToName(value, containers ?? [])
  const query = shown.trim()
  const items: Candidate[] = React.useMemo(
    () => (open && query.startsWith("@") ? targetCandidates(direction, query.slice(1), containers ?? []) : []),
    [open, query, direction, containers]
  )
  const chip = describeTarget(value, containers, direction)

  function pick(item: Candidate) {
    setDraft(null)
    setOpen(false)
    onChange(containerRefToId(item.value, containers ?? []))
    onPicked?.()
  }

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn("font-mono text-xs", chip && !open ? "pr-24" : "")}
        placeholder={placeholder}
        value={shown}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          const text = event.target.value
          setDraft(text)
          setOpen(true)
          setActive(0)
          onChange(containerRefToId(text, containers ?? []))
        }}
        onBlur={() => {
          setDraft(null)
          setOpen(false)
          onBlurred?.()
        }}
        onKeyDown={(event) => {
          if (!items.length) return
          if (event.key === "ArrowDown") {
            setActive((index) => Math.min(index + 1, items.length - 1))
            event.preventDefault()
          } else if (event.key === "ArrowUp") {
            setActive((index) => Math.max(index - 1, 0))
            event.preventDefault()
          } else if (event.key === "Enter") {
            pick(items[Math.min(active, items.length - 1)])
            event.preventDefault()
          } else if (event.key === "Escape") {
            setOpen(false)
            event.stopPropagation()
          }
        }}
      />
      {chip && !open ? (
        <span className="pointer-events-none absolute top-1/2 right-2 max-w-[45%] -translate-y-1/2 truncate text-xs text-muted-foreground">{chip}</span>
      ) : null}
      {open && query.startsWith("@") ? (
        <div
          role="listbox"
          className="absolute top-[calc(100%+4px)] left-0 z-50 max-h-64 w-[max(100%,18rem)] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground">没有匹配的对象</div> : null}
          {items.map((item, index) => {
            const heading = index === 0 || items[index - 1].group !== item.group ? item.group : ""
            return (
              <React.Fragment key={item.value}>
                {heading ? <div className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">{heading}</div> : null}
                <div
                  role="option"
                  aria-selected={index === active}
                  className={cn("flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm", index === active ? "bg-accent" : "hover:bg-accent")}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pick(item)
                  }}
                >
                  <span className="font-mono text-xs whitespace-nowrap">
                    @<Highlight text={item.value.slice(1)} hit={item.hit} />
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{item.desc}</span>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
