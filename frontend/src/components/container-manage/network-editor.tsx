import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RowList, type RowColumn } from "@/components/container-manage/row-list"
import { RuleTable } from "@/components/container-manage/rule-table"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import {
  type DerivedRule,
  type NetworkPolicy,
  type PeerOption,
  type Preset,
  PRESET_HINTS,
  PRESET_LABELS,
  newRule,
  ruleValue,
  switchPreset,
} from "@/lib/container-manage"

const PRESETS: Preset[] = ["restricted", "allowlist", "custom"]
const BIND_OPTIONS = [
  { value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
  { value: "0.0.0.0", label: "0.0.0.0（局域网 / 公网）" },
]

type ExposeRow = { bind: string; hostPort: string; port: string }

const filled = (...values: string[]) => values.every((value) => value.trim() !== "")

// 网络策略编辑：出站 / 入站是同一种规则表（RuleTable），端口暴露沿用 RowList。
// 暴露行状态在本组件内（允许暂时空着的新行），只把填完整的行写回策略；父组件重新加载策略时用 key 重建本组件。
export function NetworkEditor({
  policy,
  onChange,
  peers,
  derived = [],
  forwards = [],
  showAccess = true,
  suggestedDomains = [],
}: {
  policy: NetworkPolicy
  onChange: (policy: NetworkPolicy) => void
  /** 其他容器；不传表示容器列表未知（新建容器），规则里的 @container:<名称> 不校验是否存在 */
  peers?: PeerOption[]
  /** 本容器出站里由别的容器入站规则派生出的只读放行行 */
  derived?: DerivedRule[]
  /** 当前真正在监听的端口暴露（用来显示「打开」链接） */
  forwards?: Array<{ bind: string; hostPort: number; port: number }>
  /** 是否显示「访问」列（新建容器时还没有在监听，不需要） */
  showAccess?: boolean
  /** 来自环境变量里 URL 的域名（如模型服务），仅白名单模式下可一键加入 */
  suggestedDomains?: string[]
}) {
  const { confirm, dialog } = useConfirmDialog()
  const [expose, setExpose] = React.useState<ExposeRow[]>(() =>
    policy.expose.map((entry) => ({ bind: entry.bind, hostPort: String(entry.hostPort), port: String(entry.port) }))
  )

  function emitExpose(next: ExposeRow[]) {
    onChange({
      ...policy,
      expose: next
        .filter((row) => filled(row.hostPort, row.port) && Number.isInteger(Number(row.hostPort)) && Number.isInteger(Number(row.port)))
        .map((row) => ({ bind: row.bind, hostPort: Number(row.hostPort), port: Number(row.port) })),
    })
  }

  async function choosePreset(next: Preset) {
    if (next === policy.preset) return
    if (next === "custom") {
      const ok = await confirm({
        title: "改成自定义？",
        message: "「自定义」初始只有一行“允许 @any”：容器能访问宿主机、内网和云元数据，之后可以自己改。",
        confirmLabel: "确认",
      })
      if (!ok) return
    }
    onChange(switchPreset(policy, next))
  }

  const outboundDomains = new Set(policy.outbound.map((rule) => ruleValue(rule, "outbound").trim().toLowerCase()))
  const suggestions = policy.preset === "allowlist" ? suggestedDomains.filter((domain) => !outboundDomains.has(domain)) : []

  const exposeColumns: RowColumn<ExposeRow>[] = [
    { key: "bind", label: "宿主机监听地址", options: BIND_OPTIONS, className: "flex-[2]" },
    { key: "hostPort", label: "宿主机监听端口", placeholder: "18080", inputMode: "numeric", className: "w-28 sm:w-32" },
    { key: "port", label: "容器端口", placeholder: "8080", inputMode: "numeric", className: "w-24 sm:w-28" },
  ]

  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel>
          出站 <span className="font-normal text-muted-foreground">容器访问外部</span>
        </FieldLabel>
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[policy.preset]}
          onValueChange={(values) => {
            const next = values[0] as Preset | undefined
            if (next) void choosePreset(next)
          }}
        >
          {PRESETS.map((preset) => (
            <ToggleGroupItem key={preset} value={preset}>
              {PRESET_LABELS[preset]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>{PRESET_HINTS[policy.preset]}</FieldDescription>
        <RuleTable
          direction="outbound"
          preset={policy.preset}
          rules={policy.outbound}
          containers={peers}
          derived={derived}
          onChange={(outbound) => onChange({ ...policy, outbound })}
        />
        {suggestions.length ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>环境变量里出现的域名（如 Agent 的模型服务，不放行就无法对话）：</span>
            {suggestions.map((domain) => (
              <Button
                key={domain}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onChange({ ...policy, outbound: [...policy.outbound.filter((rule) => ruleValue(rule, "outbound").trim()), newRule("outbound", domain)] })}
              >
                + {domain}
              </Button>
            ))}
          </div>
        ) : null}
      </Field>

      <Field>
        <FieldLabel>
          入站 <span className="font-normal text-muted-foreground">外部访问容器</span>
        </FieldLabel>
        <RuleTable
          direction="inbound"
          preset={policy.preset}
          rules={policy.inbound}
          containers={peers}
          onChange={(inbound) => onChange({ ...policy, inbound })}
        />
      </Field>

      <Field>
        <FieldLabel>端口暴露</FieldLabel>
        <RowList
          ariaPrefix="端口暴露"
          rows={expose}
          columns={exposeColumns}
          newRow={() => ({ bind: "127.0.0.1", hostPort: "", port: "" })}
          addLabel="添加端口暴露"
          renderExtra={showAccess ? {
            label: "访问",
            width: "w-12",
            render: (row) => {
              const active = forwards.some((f) => f.bind === row.bind && String(f.hostPort) === row.hostPort && String(f.port) === row.port)
              if (!active) return <span className="text-muted-foreground">—</span>
              const target = row.bind === "0.0.0.0" ? window.location.hostname : row.bind
              return (
                <a className="text-primary underline-offset-2 hover:underline" href={`http://${target}:${row.hostPort}/`} target="_blank" rel="noreferrer">
                  打开
                </a>
              )
            },
          } : undefined}
          onChange={(next) => {
            setExpose(next)
            emitExpose(next)
          }}
        />
        <FieldDescription>把容器端口映射到宿主机，保存后立即生效。绑定 0.0.0.0 会让局域网 / 公网可见，保存时会二次确认。</FieldDescription>
      </Field>
      {dialog}
    </div>
  )
}
