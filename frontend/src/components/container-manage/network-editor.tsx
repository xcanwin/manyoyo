import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import {
  type NetworkPolicy,
  type PeerOption,
  type Preset,
  PRESET_HINTS,
  PRESET_LABELS,
  formatDomainLines,
  formatHostLines,
  formatRuleLines,
  parseDomainLines,
  parseHostLines,
  parseRuleLines,
} from "@/lib/container-manage"

const PRESETS: Preset[] = ["restricted", "allowlist", "open"]

// 网络策略编辑（不含端口暴露：它是运行中即时增删的，在「容器」页单独管理）。
// 文本框在本地持有输入，解析后回写策略；父组件在重新加载策略时用 key 重建本组件。
export function NetworkEditor({
  policy,
  onChange,
  peers,
  idPrefix,
  showPeers = true,
}: {
  policy: NetworkPolicy
  onChange: (policy: NetworkPolicy) => void
  peers: PeerOption[]
  idPrefix: string
  showPeers?: boolean
}) {
  const { confirm, dialog } = useConfirmDialog()
  const [domainsText, setDomainsText] = React.useState(() => formatDomainLines(policy.egress.domains))
  const [rulesText, setRulesText] = React.useState(() => formatRuleLines(policy.egress.rules))
  const [hostText, setHostText] = React.useState(() => formatHostLines(policy.host))

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

  function addPeer() {
    const first = peers.find((peer) => !policy.peers.inbound.some((entry) => entry.from === peer.id))
    if (!first) return
    onChange({ ...policy, peers: { inbound: [...policy.peers.inbound, { from: first.id, ports: "", proto: "tcp" }] } })
  }

  function updatePeer(index: number, patch: Partial<NetworkPolicy["peers"]["inbound"][number]>) {
    onChange({
      ...policy,
      peers: { inbound: policy.peers.inbound.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) },
    })
  }

  return (
    <div className="flex flex-col gap-4">
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
        <FieldDescription>{PRESET_HINTS[policy.preset]}</FieldDescription>
      </Field>

      {policy.preset === "allowlist" ? (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-domains`}>允许的域名（每行一个，支持 *.example.com）</FieldLabel>
          <Textarea
            id={`${idPrefix}-domains`}
            className="min-h-20 font-mono text-xs"
            placeholder={"github.com\n*.anthropic.com"}
            value={domainsText}
            onChange={(event) => {
              setDomainsText(event.target.value)
              onChange({ ...policy, egress: { ...policy.egress, domains: parseDomainLines(event.target.value) } })
            }}
          />
          <FieldDescription>仅 HTTP(S)：经 serve 内的过滤代理，按域名放行；解析到私有地址的域名一律拒绝。</FieldDescription>
        </Field>
      ) : null}

      {policy.preset !== "open" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-rules`}>额外放行的 IP 规则（每行：CIDR [端口] [tcp|udp]）</FieldLabel>
            <Textarea
              id={`${idPrefix}-rules`}
              className="min-h-16 font-mono text-xs"
              placeholder="192.168.1.50 8000"
              value={rulesText}
              onChange={(event) => {
                setRulesText(event.target.value)
                onChange({ ...policy, egress: { ...policy.egress, rules: parseRuleLines(event.target.value) } })
              }}
            />
            <FieldDescription>
              直连放行：收紧模式下用来放开私有网段里的指定服务（例如局域网里的模型网关），仅白名单模式下用于 ssh、数据库等非 HTTP 协议。新建容器时 env 里填的 *_BASE_URL 指向私有地址会自动写进这里。
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-host`}>允许访问的宿主机端口（每行：端口[/协议]）</FieldLabel>
            <Textarea
              id={`${idPrefix}-host`}
              className="min-h-16 font-mono text-xs"
              placeholder={"18601\n5353/udp"}
              value={hostText}
              onChange={(event) => {
                setHostText(event.target.value)
                onChange({ ...policy, host: parseHostLines(event.target.value) })
              }}
            />
            <FieldDescription>宿主机上监听 0.0.0.0 的服务；只绑 127.0.0.1 的服务容器访问不到。</FieldDescription>
          </Field>

          {showPeers ? (
          <Field>
            <FieldLabel>允许其他容器访问我</FieldLabel>
            <div className="flex flex-col gap-2">
              {policy.peers.inbound.map((entry, index) => (
                <div key={entry.from} className="flex items-center gap-2">
                  <Select value={entry.from} onValueChange={(value) => value && updatePeer(index, { from: value })}>
                    <SelectTrigger aria-label="来源容器" className="min-w-0 flex-1">
                      <SelectValue placeholder="选择容器" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {peers.map((peer) => (
                          <SelectItem key={peer.id} value={peer.id}>
                            {peer.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label="端口"
                    className="w-28 font-mono text-xs"
                    placeholder="7000"
                    value={entry.ports}
                    onChange={(event) => updatePeer(index, { ports: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="删除这一条"
                    onClick={() =>
                      onChange({ ...policy, peers: { inbound: policy.peers.inbound.filter((_, i) => i !== index) } })
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={peers.length === 0 || policy.peers.inbound.length >= peers.length}
                  onClick={addPeer}
                >
                  <PlusIcon data-icon="inline-start" />
                  添加来源容器
                </Button>
              </div>
            </div>
            <FieldDescription>
              {peers.length === 0 ? "没有其他容器可选。" : "默认容器之间互相不通；在这里放行后，对方也能出站访问到本容器。"}
            </FieldDescription>
          </Field>
          ) : null}
        </>
      ) : null}
      {dialog}
    </div>
  )
}
