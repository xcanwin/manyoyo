import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { formatDateTime } from "@/lib/format"
import type { DeniedRecord } from "@/lib/container-manage"

function Row({ record, disabled, onAllow }: { record: DeniedRecord; disabled: boolean; onAllow: (host: string) => void }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate" title={record.host}>
        {record.host}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {record.count} 次 · {formatDateTime(record.last)}
      </span>
      <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => onAllow(record.host)}>
        允许
      </Button>
    </div>
  )
}

// 白名单模式下被过滤代理拦下的域名：一键允许（加进白名单并立即生效）。浏览器自己的后台请求折叠在下面。
export function DeniedList({
  denied,
  disabled,
  onAllow,
}: {
  denied: DeniedRecord[]
  /** 白名单有未保存的修改时先不允许一键放行，避免覆盖 */
  disabled: boolean
  onAllow: (host: string) => void
}) {
  const normal = denied.filter((record) => !record.background)
  const background = denied.filter((record) => record.background)
  return (
    <div className="flex flex-col gap-2">
      {normal.length ? (
        normal.map((record) => <Row key={`${record.host}:${record.port}`} record={record} disabled={disabled} onAllow={onAllow} />)
      ) : (
        <p className="text-sm text-muted-foreground">暂无</p>
      )}
      {background.length ? (
        <Collapsible>
          <CollapsibleTrigger className="group/section flex w-full items-center justify-between gap-2 rounded-md py-0.5 text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            浏览器后台请求（{background.length}）
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/section:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 pt-2">
            {background.map((record) => (
              <Row key={`${record.host}:${record.port}`} record={record} disabled={disabled} onAllow={onAllow} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}
