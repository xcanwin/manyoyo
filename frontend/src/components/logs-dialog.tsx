import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import {
  apiGet,
  formatLogExtra,
  logLevelBadgeVariant,
  type ServeLogEntry,
  type ServeLogPage,
} from "@/lib/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

const LEVEL_OPTIONS = [
  { value: "all", label: "全部级别" },
  { value: "WARN,ERROR", label: "仅警告与错误" },
  { value: "ERROR", label: "仅错误" },
  { value: "INFO", label: "仅信息" },
]

// serve 日志的时间戳是本地时间字符串（见 bin/manyoyo.js 的 formatLocalTimestamp），
// 列表里只需要时分秒，日期已经由上方的日期选择器确定
function formatLogTime(ts: string): string {
  const matched = String(ts || "").match(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/)
  return matched ? matched[0] : ts
}

function LogRow({ entry }: { entry: ServeLogEntry }) {
  const extras = formatLogExtra(entry.extra)
  return (
    <div className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {formatLogTime(entry.ts)}
        </span>
        <Badge variant={logLevelBadgeVariant(entry.level)}>{entry.level}</Badge>
        <span className="min-w-0 break-words font-medium">{entry.message}</span>
      </div>
      {extras.length ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 pl-1 font-mono text-xs text-muted-foreground">
          {extras.map((item) => (
            <span key={item} className="break-all">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function LogsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [dates, setDates] = React.useState<string[]>([])
  const [date, setDate] = React.useState("")
  const [level, setLevel] = React.useState("all")
  const [keyword, setKeyword] = React.useState("")
  const [entries, setEntries] = React.useState<ServeLogEntry[]>([])
  const [nextEndOffset, setNextEndOffset] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState("")

  const buildQuery = React.useCallback(
    (endOffset?: number | null) => {
      const params = new URLSearchParams()
      if (date) params.set("date", date)
      if (level !== "all") params.set("level", level)
      if (keyword.trim()) params.set("keyword", keyword.trim())
      if (endOffset !== undefined && endOffset !== null) {
        params.set("endOffset", String(endOffset))
      }
      return params.toString()
    },
    [date, level, keyword]
  )

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const data = (await apiGet(`/api/logs?${buildQuery()}`)) as unknown as ServeLogPage
      setEntries(Array.isArray(data.entries) ? data.entries : [])
      setNextEndOffset(typeof data.nextEndOffset === "number" ? data.nextEndOffset : null)
      if (!date && data.date) setDate(data.date)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载日志失败")
    } finally {
      setLoading(false)
    }
  }, [buildQuery, date])

  async function loadMore() {
    if (nextEndOffset === null || loadingMore) return
    setLoadingMore(true)
    setError("")
    try {
      const data = (await apiGet(
        `/api/logs?${buildQuery(nextEndOffset)}`
      )) as unknown as ServeLogPage
      setEntries((prev) => [...prev, ...(Array.isArray(data.entries) ? data.entries : [])])
      setNextEndOffset(typeof data.nextEndOffset === "number" ? data.nextEndOffset : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载更早日志失败")
    } finally {
      setLoadingMore(false)
    }
  }

  // 打开时拉一次可选日期，之后筛选条件变化再重新拉列表
  React.useEffect(() => {
    if (!open) return
    apiGet("/api/logs/dates")
      .then((data) => {
        const list = Array.isArray(data.dates) ? (data.dates as string[]) : []
        setDates(list)
        if (!date && list.length) setDate(list[0])
      })
      .catch(() => setDates([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (!open) return
    load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>运行日志</DialogTitle>
          <DialogDescription>
            serve 进程日志，最新的在最上面。排查「任务跑到一半断流」这类问题时看
            agent stream client disconnected 这条。
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select value={date} onValueChange={(value) => setDate(value ?? "")}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="选择日期" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {dates.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select value={level} onValueChange={(value) => setLevel(value ?? "all")}>
            <SelectTrigger className="w-36">
              {/* base-ui 的 SelectValue 默认把原始 value 直接渲染出来（会显示成 "all"），
                  用 children 函数映射回可读标签 */}
              <SelectValue>
                {(value: string) =>
                  LEVEL_OPTIONS.find((item) => item.value === value)?.label ?? "全部级别"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LEVEL_OPTIONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索消息或字段，例如容器名"
            className="w-56"
          />
          <Button variant="outline" onClick={load} disabled={loading}>
            {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            刷新
          </Button>
        </div>

        {error ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && !entries.length ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-6" />
            </div>
          ) : entries.length ? (
            <div className="flex flex-col divide-y [&>*]:shrink-0">
              {entries.map((entry, index) => (
                <LogRow key={`${entry.ts}-${index}`} entry={entry} />
              ))}
              {nextEndOffset !== null ? (
                <div className="flex justify-center py-3">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? <Spinner data-icon="inline-start" /> : null}
                    载入更早
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-medium">没有匹配的日志</p>
              <p className="text-sm text-muted-foreground">换个日期或放宽筛选条件试试。</p>
            </div>
          )}
        </div>

        <Separator className="shrink-0" />
        <p className="shrink-0 text-xs text-muted-foreground">
          日志文件在 ~/.manyoyo/logs/serve/ 下按天存放，这里按需分页读取，不会整份载入。
        </p>
      </DialogContent>
    </Dialog>
  )
}
