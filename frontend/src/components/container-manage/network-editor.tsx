import * as React from "react"

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RowList, type RowColumn } from "@/components/container-manage/row-list"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import {
  type NetworkPolicy,
  type PeerOption,
  type Preset,
  PRESET_HINTS,
  PRESET_LABELS,
} from "@/lib/container-manage"

const PRESETS: Preset[] = ["restricted", "allowlist", "open"]
const PROTO_OPTIONS = [
  { value: "tcp", label: "tcp" },
  { value: "udp", label: "udp" },
]
const BIND_OPTIONS = [
  { value: "127.0.0.1", label: "127.0.0.1（仅本机）" },
  { value: "0.0.0.0", label: "0.0.0.0（局域网 / 公网）" },
]

type DomainRow = { domain: string }
type RuleRow = { cidr: string; ports: string; proto: string }
type HostRow = { ports: string; proto: string }
type PeerRow = { from: string; ports: string; proto: string }
type ExposeRow = { bind: string; hostPort: string; port: string }

const proto = (value: string) => (value === "udp" ? "udp" : "tcp")
const filled = (...values: string[]) => values.every((value) => value.trim() !== "")

// 网络策略编辑：所有“一行一项”的规则统一用 RowList（列名 → 输入框 → 删除 → 添加）。
// 行状态在本组件内（允许暂时空着的新行），只把填完整的行写回策略；父组件重新加载策略时用 key 重建本组件。
export function NetworkEditor({
  policy,
  onChange,
  peers,
  showPeers = true,
  forwards = [],
  showAccess = true,
}: {
  policy: NetworkPolicy
  onChange: (policy: NetworkPolicy) => void
  peers: PeerOption[]
  showPeers?: boolean
  /** 当前真正在监听的端口暴露（用来显示「打开」链接） */
  forwards?: Array<{ bind: string; hostPort: number; port: number }>
  /** 是否显示「访问」列（新建容器时还没有在监听，不需要） */
  showAccess?: boolean
}) {
  const { confirm, dialog } = useConfirmDialog()
  const [domains, setDomains] = React.useState<DomainRow[]>(() => policy.egress.domains.map((domain) => ({ domain })))
  const [rules, setRules] = React.useState<RuleRow[]>(() => policy.egress.rules.map((rule) => ({ ...rule })))
  const [host, setHost] = React.useState<HostRow[]>(() => policy.host.map((rule) => ({ ...rule })))
  const [inbound, setInbound] = React.useState<PeerRow[]>(() => policy.peers.inbound.map((entry) => ({ ...entry })))
  const [expose, setExpose] = React.useState<ExposeRow[]>(() =>
    policy.expose.map((entry) => ({ bind: entry.bind, hostPort: String(entry.hostPort), port: String(entry.port) }))
  )

  function emit(next: {
    domains?: DomainRow[]
    rules?: RuleRow[]
    host?: HostRow[]
    inbound?: PeerRow[]
    expose?: ExposeRow[]
  }) {
    const d = next.domains ?? domains
    const r = next.rules ?? rules
    const h = next.host ?? host
    const i = next.inbound ?? inbound
    const e = next.expose ?? expose
    onChange({
      ...policy,
      egress: {
        domains: d.filter((row) => filled(row.domain)).map((row) => row.domain.trim().toLowerCase()),
        rules: r.filter((row) => filled(row.cidr)).map((row) => ({ cidr: row.cidr.trim(), ports: row.ports.replace(/\s+/g, ""), proto: proto(row.proto) })),
      },
      host: h.filter((row) => filled(row.ports)).map((row) => ({ ports: row.ports.replace(/\s+/g, ""), proto: proto(row.proto) })),
      peers: {
        inbound: i.filter((row) => filled(row.from, row.ports)).map((row) => ({ from: row.from, ports: row.ports.replace(/\s+/g, ""), proto: proto(row.proto) })),
      },
      expose: e
        .filter((row) => filled(row.hostPort, row.port) && Number.isInteger(Number(row.hostPort)) && Number.isInteger(Number(row.port)))
        .map((row) => ({ bind: row.bind, hostPort: Number(row.hostPort), port: Number(row.port) })),
    })
  }

  async function choosePreset(next: Preset) {
    if (next === policy.preset) return
    if (next === "open") {
      const ok = await confirm({
        title: "放开网络限制？",
        message: "「开放」不加任何网络规则：容器里的 Agent 能访问宿主机的所有端口、局域网和云元数据地址。只在你确实需要时使用。",
        confirmLabel: "确认放开",
      })
      if (!ok) return
    }
    onChange({ ...policy, preset: next })
  }

  const ruleColumns: RowColumn<RuleRow>[] = [
    { key: "cidr", label: "IP / CIDR", placeholder: "192.168.1.50", className: "flex-[2]" },
    { key: "ports", label: "端口（可留空）", placeholder: "8000", className: "w-24 sm:w-32" },
    { key: "proto", label: "协议", options: PROTO_OPTIONS, className: "w-[4.5rem]" },
  ]
  const hostColumns: RowColumn<HostRow>[] = [
    { key: "ports", label: "端口", placeholder: "11434", className: "flex-1" },
    { key: "proto", label: "协议", options: PROTO_OPTIONS, className: "w-[4.5rem]" },
  ]
  const peerColumns: RowColumn<PeerRow>[] = [
    { key: "from", label: "来源容器", placeholder: "选择容器", options: peers.map((peer) => ({ value: peer.id, label: peer.name })), className: "flex-[2]" },
    { key: "ports", label: "端口", placeholder: "7000", className: "w-24 sm:w-32" },
    { key: "proto", label: "协议", options: PROTO_OPTIONS, className: "w-[4.5rem]" },
  ]
  const exposeColumns: RowColumn<ExposeRow>[] = [
    { key: "bind", label: "宿主机监听地址", options: BIND_OPTIONS, className: "flex-[2]" },
    { key: "hostPort", label: "宿主机监听端口", placeholder: "18080", inputMode: "numeric", className: "w-28 sm:w-32" },
    { key: "port", label: "容器端口", placeholder: "8080", inputMode: "numeric", className: "w-24 sm:w-28" },
  ]

  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel>出站</FieldLabel>
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
        <FieldDescription className="whitespace-pre-line">{PRESET_HINTS[policy.preset]}</FieldDescription>
      </Field>

      {policy.preset === "allowlist" ? (
        <Field>
          <FieldLabel>允许的域名</FieldLabel>
          <RowList
            ariaPrefix="域名"
            rows={domains}
            columns={[{ key: "domain", label: "域名（支持 *.example.com）", placeholder: "github.com" }]}
            newRow={() => ({ domain: "" })}
            addLabel="添加域名"
            onChange={(next) => {
              setDomains(next)
              emit({ domains: next })
            }}
          />
          <FieldDescription>仅 HTTP(S)：经 serve 内的过滤代理，按域名放行；解析到私有地址的域名一律拒绝。</FieldDescription>
        </Field>
      ) : null}

      {policy.preset !== "open" ? (
        <>
          <Field>
            <FieldLabel>额外放行的 IP 规则</FieldLabel>
            <RowList
              ariaPrefix="IP 规则"
              rows={rules}
              columns={ruleColumns}
              newRow={() => ({ cidr: "", ports: "", proto: "tcp" })}
              addLabel="添加 IP 规则"
              onChange={(next) => {
                setRules(next)
                emit({ rules: next })
              }}
            />
            <FieldDescription>
              直连放行：收紧模式下用来放开私有网段里的指定服务（例如局域网里的模型网关），仅白名单模式下用于 ssh、数据库等非 HTTP 协议。新建容器时 env 里填的 *_BASE_URL 指向私有地址会自动写进这里。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>允许访问的宿主机端口</FieldLabel>
            <RowList
              ariaPrefix="宿主机端口"
              rows={host}
              columns={hostColumns}
              newRow={() => ({ ports: "", proto: "tcp" })}
              addLabel="添加宿主机端口"
              onChange={(next) => {
                setHost(next)
                emit({ host: next })
              }}
            />
            <FieldDescription>宿主机上监听 0.0.0.0 的服务；只绑 127.0.0.1 的服务容器访问不到。端口可写 80、80-90 或 80,443。</FieldDescription>
          </Field>

          {showPeers ? (
            <Field>
              <FieldLabel>允许其他容器访问我</FieldLabel>
              <RowList
                ariaPrefix="来源容器"
                rows={inbound}
                columns={peerColumns}
                newRow={() => ({
                  from: peers.find((peer) => !inbound.some((row) => row.from === peer.id))?.id ?? "",
                  ports: "",
                  proto: "tcp",
                })}
                addLabel="添加来源容器"
                disableAdd={peers.length === 0 || inbound.length >= peers.length}
                onChange={(next) => {
                  setInbound(next)
                  emit({ inbound: next })
                }}
              />
              <FieldDescription>
                {peers.length === 0 ? "没有其他容器可选。" : "默认容器之间互相不通；在这里放行后，对方也能出站访问到本容器。"}
              </FieldDescription>
            </Field>
          ) : null}
        </>
      ) : null}

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
            emit({ expose: next })
          }}
        />
        <FieldDescription>
          把容器端口映射到宿主机，保存后生效、无需重启，serve 重启后自动恢复。绑定 0.0.0.0 等于局域网 / 公网可见（取决于宿主机的网络与防火墙），保存时会二次确认。
        </FieldDescription>
      </Field>
      {dialog}
    </div>
  )
}
