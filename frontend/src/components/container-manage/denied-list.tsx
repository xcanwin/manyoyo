import { Button } from "@/components/ui/button"
import { SectionToggle } from "@/components/section-toggle"
import { formatDateTime } from "@/lib/format"
import type { DeniedRecord } from "@/lib/container-manage"

import { Hint } from "@/components/hint"
function Row({ record, disabled, onAllow }: { record: DeniedRecord; disabled: boolean; onAllow: (host: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate" title={record.host}>
        {record.host}
      </span>
      <Hint className="shrink-0">
        {record.count} 次 · {formatDateTime(record.last)}
      </Hint>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onAllow(record.host)}>
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
        <Hint className="block">暂无</Hint>
      )}
      {background.length ? (
        <SectionToggle title={`浏览器后台请求（${background.length}）`}>
          <div className="flex flex-col gap-2">
            {background.map((record) => (
              <Row key={`${record.host}:${record.port}`} record={record} disabled={disabled} onAllow={onAllow} />
            ))}
          </div>
        </SectionToggle>
      ) : null}
    </div>
  )
}
