import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, LockIcon, PauseIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TargetInput } from "@/components/container-manage/target-input"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  type Action,
  type DerivedRule,
  type Direction,
  type LockedRule,
  type PeerOption,
  type Preset,
  type Proto,
  type Rule,
  INBOUND_TOP,
  OUTBOUND_TOP,
  describeTarget,
  isShadowingRule,
  modeDefaultRules,
  moveRule,
  newRule,
  removeRule,
  ruleValue,
  setRuleValue,
  toggleRule,
  validatePorts,
  validateRule,
} from "@/lib/container-manage"
import { cn } from "@/lib/utils"

const ACTIONS: Array<{ value: Action; label: string }> = [
  { value: "allow", label: "允许" },
  { value: "deny", label: "拒绝" },
]
const PROTOS: Proto[] = ["all", "tcp", "udp"]
const actionTone = (action: Action) => (action === "allow" ? "text-emerald-600 dark:text-emerald-500" : "text-destructive")

const DESKTOP_GRID = "grid grid-cols-[4.75rem_minmax(0,1fr)_7rem_4.5rem_7.5rem] items-center gap-2"

function LockedRow({ rule, containers, tip, mobile, ports = "全部", proto = "all" }: { rule: LockedRule; containers?: PeerOption[]; tip: string; mobile: boolean; ports?: string; proto?: string }) {
  const fixed = "flex h-8 items-center gap-2 rounded-lg bg-muted/60 px-2 text-sm text-muted-foreground"
  const lock = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-xs text-muted-foreground" />}>
        <LockIcon className="size-3.5" />
        {tip}
      </TooltipTrigger>
      <TooltipContent>{rule.why}</TooltipContent>
    </Tooltip>
  )
  const action = <div className={cn(fixed, "font-semibold", actionTone(rule.action))}>{rule.action === "allow" ? "允许" : "拒绝"}</div>
  const target = (
    <div className={cn(fixed, "min-w-0")}>
      <span className="font-mono text-xs text-foreground">{rule.target}</span>
      <span className="truncate">{describeTarget(rule.target, containers)}</span>
    </div>
  )
  if (mobile) {
    return (
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2" title={rule.why}>
        {action}
        {target}
      </div>
    )
  }
  return (
    <div className={DESKTOP_GRID}>
      {action}
      {target}
      <div className={fixed}>{ports}</div>
      <div className={fixed}>{proto}</div>
      <div className="flex justify-center">{lock}</div>
    </div>
  )
}

function UserRow({
  rule,
  index,
  count,
  direction,
  preset,
  containers,
  mobile,
  onChange,
  onMove,
  onToggle,
  onRemove,
}: {
  rule: Rule
  index: number
  count: number
  direction: Direction
  preset: Preset
  containers?: PeerOption[]
  mobile: boolean
  onChange: (rule: Rule) => void
  onMove: (delta: -1 | 1) => void
  onToggle: () => void
  onRemove: () => void
}) {
  const [touched, setTouched] = React.useState(false)
  const [portsTouched, setPortsTouched] = React.useState(false)
  const rowRef = React.useRef<HTMLDivElement>(null)
  const label = direction === "outbound" ? "出站规则" : "入站规则"
  const n = index + 1
  const value = ruleValue(rule, direction)
  const portsError = portsTouched ? validatePorts(rule.ports) : ""
  const targetError = touched && value.trim() ? validateRule({ ...rule, ports: "" }, direction, containers) : ""
  const error = targetError || portsError || (portsTouched || touched ? validateRule(rule, direction, containers) : "")
  const off = !rule.enabled

  const action = (
    <Select value={rule.action} onValueChange={(next) => next && onChange({ ...rule, action: next as Action })}>
      <SelectTrigger aria-label={`${label}第 ${n} 行动作`} className={cn("w-full min-w-0 font-semibold", actionTone(rule.action), off && "opacity-45")}>
        <SelectValue>{(value: string) => ACTIONS.find((item) => item.value === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {ACTIONS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
  const target = (
    <div className={cn("min-w-0", off && "opacity-45 [&_input]:line-through")}>
      <TargetInput
        ariaLabel={`${label}第 ${n} 行${direction === "outbound" ? "目标" : "来源"}`}
        direction={direction}
        value={value}
        containers={containers}
        invalid={!!targetError}
        placeholder={direction === "outbound" ? "域名、IP、网段，输入 @ 选择" : "IP / 网段，输入 @ 选择"}
        onChange={(next) => onChange(setRuleValue(rule, direction, next))}
        onBlurred={() => setTouched(true)}
        onPicked={() => rowRef.current?.querySelector<HTMLInputElement>("[data-field=ports]")?.focus()}
      />
    </div>
  )
  const ports = (
    <Input
      data-field="ports"
      aria-label={`${label}第 ${n} 行${direction === "outbound" ? "目标端口" : "容器端口"}`}
      aria-invalid={!!portsError || undefined}
      className={cn("min-w-0 font-mono text-xs", off && "opacity-45")}
      placeholder="全部"
      value={rule.ports}
      onChange={(event) => onChange({ ...rule, ports: event.target.value })}
      onBlur={() => setPortsTouched(true)}
    />
  )
  const proto = (
    <Select value={rule.proto} onValueChange={(next) => next && onChange({ ...rule, proto: next as Proto })}>
      <SelectTrigger aria-label={`${label}第 ${n} 行协议`} className={cn("w-full min-w-0 text-xs", off && "opacity-45")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {PROTOS.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
  const ops = (
    <div className="flex justify-center">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`上移${label}第 ${n} 行`} title="上移" disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUpIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`下移${label}第 ${n} 行`} title="下移" disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDownIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`${off ? "恢复" : "暂停"}${label}第 ${n} 行`} title={off ? "恢复" : "暂停"} onClick={onToggle}>
        {off ? <PlayIcon /> : <PauseIcon />}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除${label}第 ${n} 行`} title="删除" onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  )
  return (
    <div className="flex flex-col gap-1">
      {mobile ? (
        <div ref={rowRef} className="flex flex-col gap-1.5 border-b pb-2">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
            {action}
            {target}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_auto] items-center gap-2">
            {ports}
            {proto}
            {ops}
          </div>
        </div>
      ) : (
        <div ref={rowRef} className={DESKTOP_GRID}>
          {action}
          {target}
          {ports}
          {proto}
          {ops}
        </div>
      )}
      {error ? <p className={cn("text-xs text-destructive", !mobile && "pl-[5.25rem]")}>{error}</p> : null}
      {isShadowingRule(rule, direction, preset) ? (
        <p className={cn("text-xs text-muted-foreground", !mobile && "pl-[5.25rem]")}>下面的规则不会生效</p>
      ) : null}
    </div>
  )
}

// 出站、入站共用的规则表：顶部锁定行 → 派生行 → 用户规则（可上移 / 下移 / 暂停 / 删除）→ 模式默认行。
// 从上往下匹配，第一条命中的生效。用户规则含空行（还没填目标），保存时由 cleanPolicy 去掉。
export function RuleTable({
  direction,
  preset,
  rules,
  onChange,
  containers,
  derived = [],
}: {
  direction: Direction
  preset: Preset
  rules: Rule[]
  onChange: (rules: Rule[]) => void
  /** 不传表示容器列表未知（新建容器） */
  containers?: PeerOption[]
  derived?: DerivedRule[]
}) {
  const mobile = useIsMobile()
  const top = direction === "outbound" ? OUTBOUND_TOP : INBOUND_TOP
  const defaults = modeDefaultRules(direction, preset)
  const third = direction === "outbound" ? ["目标", "目标端口"] : ["来源", "容器端口"]
  const lockedTip = (rule: LockedRule) => (rule.why.startsWith("模式默认") ? "模式默认" : "必需")
  const addLabel = direction === "outbound" ? "添加出站规则" : "添加入站规则"

  return (
    <div className="flex flex-col gap-1.5">
      {!mobile ? (
        <div className={cn(DESKTOP_GRID, "px-0.5 text-xs text-muted-foreground")}>
          <span>动作</span>
          <span>{third[0]}</span>
          <span>{third[1]}</span>
          <span>协议</span>
          <span className="text-center">操作</span>
        </div>
      ) : null}
      {top.map((rule) => (
        <LockedRow key={rule.target} rule={rule} containers={containers} tip={lockedTip(rule)} mobile={mobile} />
      ))}
      {derived.map((item) => (
        <LockedRow
          key={`${item.id}-${item.ports}-${item.proto}`}
          rule={{ action: "allow", target: `@container:${item.name}`, why: `来自 ${item.name} 的入站规则` }}
          containers={containers}
          tip="派生"
          mobile={mobile}
          ports={item.ports || "全部"}
          proto={item.proto}
        />
      ))}
      {rules.map((rule, index) => (
        <UserRow
          key={index}
          rule={rule}
          index={index}
          count={rules.length}
          direction={direction}
          preset={preset}
          containers={containers}
          mobile={mobile}
          onChange={(next) => onChange(rules.map((item, i) => (i === index ? next : item)))}
          onMove={(delta) => onChange(moveRule(rules, index, delta))}
          onToggle={() => onChange(toggleRule(rules, index))}
          onRemove={() => onChange(removeRule(rules, index))}
        />
      ))}
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground before:flex-1 before:border-t before:border-dashed after:flex-1 after:border-t after:border-dashed">
        {preset === "custom" ? "没有匹配的：允许" : "模式默认"}
      </div>
      {defaults.map((rule) => (
        <LockedRow key={rule.target + rule.action} rule={rule} containers={containers} tip="模式默认" mobile={mobile} />
      ))}
      <div className="pt-1">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rules, newRule(direction, "", { proto: direction === "outbound" ? "all" : "tcp" })])}>
          <PlusIcon data-icon="inline-start" />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
