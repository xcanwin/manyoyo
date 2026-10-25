import * as React from "react"
import { BrainIcon, CheckIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiGet, apiPost, type SessionSummary } from "@/lib/api"
import { effortLabel } from "@/lib/effort"
import { loadEffortCache, saveEffortCache } from "@/lib/effort-cache"

// 推理强度下拉（模型菜单旁边）。选项来自服务端（Agent 自己的模型目录），当前模型不支持或不知道时整个按钮不显示。
export function EffortMenu({
  session,
  disabled,
  onChanged,
  compact = false,
  size,
}: {
  session: SessionSummary | null
  disabled: boolean
  onChanged: () => void
  compact?: boolean
  size?: "icon-lg" | "icon-xl"
}) {
  const sessionName = session?.name ?? null
  const model = session?.model ?? ""
  const current = session?.effort ?? ""
  const [options, setOptions] = React.useState<{ key: string; levels: string[]; envDefault: string }>({
    key: "",
    levels: [],
    envDefault: "",
  })
  // 换会话或换模型就重新取：新模型可能不支持当前强度
  const key = `${sessionName ?? ""}\u0000${model}`

  React.useEffect(() => {
    if (!sessionName || (session?.agentProgram !== "claude" && session?.agentProgram !== "codex")) return
    let cancelled = false
    apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/effort`)
      .then((data) => {
        if (cancelled) return
        const next = {
          levels: Array.isArray(data.levels) ? (data.levels as string[]) : [],
          envDefault: typeof data.envDefault === "string" ? data.envDefault : "",
        }
        saveEffortCache(key, next)
        setOptions({ key, ...next })
      })
      .catch(() => {
        if (!cancelled) setOptions({ key, levels: [], envDefault: "" })
      })
    return () => {
      cancelled = true
    }
  }, [key, sessionName, session?.agentProgram])

  // 服务端的结果回来之前先用上次的缓存，按钮不用等一秒才出现
  const known = options.key === key ? options : loadEffortCache(key)
  const levels = known ? known.levels : []
  if (!sessionName || levels.length === 0) return null

  const shown = levels.includes(current) ? current : ""
  const defaultText = known?.envDefault ? `默认（环境变量：${known.envDefault}）` : "默认"
  const shownText = shown ? effortLabel(shown) : defaultText

  async function select(value: string) {
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(sessionName ?? "")}/effort`, { effort: value })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "设置推理强度失败")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? size || "icon-lg" : "lg"}
            className="shrink-0"
            disabled={disabled}
            title={`推理强度：${shownText}`}
            aria-label={`选择推理强度（当前：${shownText}）`}
          />
        }
      >
        <BrainIcon />
        {compact ? null : <span className="truncate">{shown ? effortLabel(shown) : "强度"}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>推理强度</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void select("")}>
            {defaultText}
            {shown === "" ? <CheckIcon className="ml-auto" /> : null}
          </DropdownMenuItem>
          {levels.map((level) => (
            <DropdownMenuItem key={level} onClick={() => void select(level)}>
              {effortLabel(level)}
              {shown === level ? <CheckIcon className="ml-auto" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
