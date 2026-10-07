// 容器管理（环境变量 / 自启动 / 网络）的类型与纯函数。语义与服务端 lib/container-state.js、
// lib/network-policy.js 保持一致：env 按第一个 = 切分、不去引号；策略的校验以服务端为准，这里只做编辑与展示。

export type EnvEntry = { key: string; value: string }
export type EnvInvalid = { line: number; text: string; reason: string }

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i
const LINE_RE = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/

// 环境变量的唯一语法，与服务端 lib/env-text.js、容器内 init.sh 等价（同一组语料测试）：
// 一行 KEY=VALUE；空行与 # 注释忽略；与 docker / podman env-file 一致，值里的空格不需要引号；
// 兼容 shell / dotenv 写法：可选 `export ` 前缀、= 两侧空白、值两端成对引号会被去掉。
function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1)
  }
  return v
}

export function parseEnvText(text: string): { entries: EnvEntry[]; invalid: EnvInvalid[] } {
  const entries: EnvEntry[] = []
  const invalid: EnvInvalid[] = []
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "")
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return
    const match = LINE_RE.exec(trimmed)
    if (!match) {
      invalid.push({ line: index + 1, text: line, reason: "缺少 KEY=VALUE" })
      return
    }
    if (!ENV_KEY_RE.test(match[1])) {
      invalid.push({ line: index + 1, text: line, reason: `key 非法: ${match[1]}` })
      return
    }
    entries.push({ key: match[1], value: unquote(match[2]) })
  })
  return { entries, invalid }
}

function needsQuote(value: string): boolean {
  return (
    /^\s|\s$/.test(value) ||
    (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'")))
  )
}

// 只在值首尾有空白、或首尾恰好是一对引号时才加引号，其余原样（表格里填 `abc 123`，文本里就是 `KEY=abc 123`）
export function formatEnvValue(value: string): string {
  if (!needsQuote(value)) return value
  const q = value[0] === '"' ? "'" : '"'
  return `${q}${value}${q}`
}

export function serializeEnv(entries: EnvEntry[]): string {
  const lines = entries.filter((entry) => entry.key.trim()).map((entry) => `${entry.key.trim()}=${formatEnvValue(entry.value)}`)
  return lines.length ? `${lines.join("\n")}\n` : ""
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key)
}

export type Proto = "all" | "tcp" | "udp"
export type Preset = "restricted" | "allowlist" | "custom"
export type Direction = "outbound" | "inbound"
export type Action = "allow" | "deny"
/** 出站规则用 target，入站规则用 source；其余字段相同 */
export type Rule = { action: Action; target?: string; source?: string; ports: string; proto: Proto; enabled: boolean }
export type ExposeEntry = { bind: string; hostPort: number; port: number }

export type NetworkPolicy = {
  version: 2
  preset: Preset
  outbound: Rule[]
  inbound: Rule[]
  expose: ExposeEntry[]
  autostartOnServe: boolean
}

export function defaultPolicy(): NetworkPolicy {
  return { version: 2, preset: "restricted", outbound: [], inbound: [], expose: [], autostartOnServe: false }
}

export function ruleValue(rule: Rule, direction: Direction): string {
  return (direction === "outbound" ? rule.target : rule.source) ?? ""
}

export function newRule(direction: Direction, value = "", init: Partial<Rule> = {}): Rule {
  const base = { action: "allow" as Action, ports: "", proto: "all" as Proto, enabled: true, ...init }
  return direction === "outbound" ? { ...base, target: value } : { ...base, source: value }
}

function withValue(rule: Rule, direction: Direction, value: string): Rule {
  const { target: _t, source: _s, ...rest } = rule
  void _t
  void _s
  return direction === "outbound" ? { ...rest, target: value } : { ...rest, source: value }
}
export { withValue as setRuleValue }

/** 去掉还没填目标的空行、规整端口与大小写，供保存与创建使用 */
export function cleanPolicy(policy: NetworkPolicy): NetworkPolicy {
  const clean = (rules: Rule[], direction: Direction): Rule[] =>
    rules
      .filter((rule) => ruleValue(rule, direction).trim() !== "")
      .map((rule) => withValue({ ...rule, ports: rule.ports.replace(/\s+/g, "") }, direction, ruleValue(rule, direction).trim()))
  return { ...policy, outbound: clean(policy.outbound, "outbound"), inbound: clean(policy.inbound, "inbound") }
}

/** 键顺序无关的结构比较（服务端返回的规则与界面里编辑过的规则键顺序可能不同） */
export function samePolicy(a: NetworkPolicy, b: NetworkPolicy): boolean {
  const canon = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canon)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, canon(v)]))
        : value
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

// 新建容器时要发给服务端的 network：与默认（收紧、无规则）相同就不发，交给 runs / 全局配置与服务端默认
// autostartOnServe 单独走自己的字段，不在 network 里
export function networkForCreate(policy: NetworkPolicy): Omit<NetworkPolicy, "autostartOnServe"> | undefined {
  const rest: Partial<NetworkPolicy> = cleanPolicy(policy)
  delete rest.autostartOnServe
  const base: Partial<NetworkPolicy> = defaultPolicy()
  delete base.autostartOnServe
  return samePolicy(rest as NetworkPolicy, base as NetworkPolicy) ? undefined : (rest as Omit<NetworkPolicy, "autostartOnServe">)
}

const isAnyAll = (rule: Rule, direction: Direction) =>
  rule.enabled && rule.action === "allow" && ruleValue(rule, direction) === "@any" && rule.ports === "" && rule.proto === "all"

/** 自定义且没有任何实际限制（只有“允许 @any”）：服务端不建规则表 */
export function isUnrestricted(policy: NetworkPolicy): boolean {
  return (
    policy.preset === "custom" &&
    policy.outbound.every((rule) => !rule.enabled || isAnyAll(rule, "outbound")) &&
    policy.inbound.every((rule) => !rule.enabled || isAnyAll(rule, "inbound"))
  )
}

/** 启用的“允许 @any（全部端口）”行：模式不是自定义时，它下面的规则不会生效 */
export function isShadowingRule(rule: Rule, direction: Direction, preset: Preset): boolean {
  return preset !== "custom" && isAnyAll(rule, direction)
}

/** 切换出站模式：用户规则保留；进入自定义时出入站各加一行“允许 @any”，离开时删掉没改过的那行 */
export function switchPreset(policy: NetworkPolicy, next: Preset): NetworkPolicy {
  if (next === policy.preset) return policy
  let { outbound, inbound } = policy
  if (next === "custom") {
    outbound = [...outbound, newRule("outbound", "@any")]
    inbound = [...inbound, newRule("inbound", "@any")]
  } else if (policy.preset === "custom") {
    const drop = (rules: Rule[], direction: Direction) => {
      const index = rules.findIndex((rule) => isAnyAll(rule, direction))
      return index < 0 ? rules : rules.filter((_, i) => i !== index)
    }
    outbound = drop(outbound, "outbound")
    inbound = drop(inbound, "inbound")
  }
  return { ...policy, preset: next, outbound, inbound }
}

export function moveRule(rules: Rule[], index: number, delta: -1 | 1): Rule[] {
  const to = index + delta
  if (index < 0 || to < 0 || to >= rules.length) return rules
  const next = [...rules]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

export function toggleRule(rules: Rule[], index: number): Rule[] {
  return rules.map((rule, i) => (i === index ? { ...rule, enabled: !rule.enabled } : rule))
}

export function removeRule(rules: Rule[], index: number): Rule[] {
  return rules.filter((_, i) => i !== index)
}

export function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1"
}

const PUBLIC_SUFFIX_WILDCARD_RE = /^\*\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/

function isWideCidr(value: string): boolean {
  const match = /^[0-9a-fA-F:.]+\/(\d+)$/.exec(value)
  if (!match) return false
  const prefix = Number(match[1])
  return value.includes(":") ? prefix <= 16 : prefix <= 8
}

function isWideRule(rule: Rule, direction: Direction): boolean {
  const value = ruleValue(rule, direction).trim().toLowerCase()
  if (value === "@any" || value === "@private" || value === "@metadata") return true
  if (direction === "inbound" && value === "@containers") return true
  if (direction === "outbound" && value === "@host" && rule.ports.trim() === "") return true
  return isWideCidr(value) || PUBLIC_SUFFIX_WILDCARD_RE.test(value)
}

function wideKeys(policy: NetworkPolicy): string[] {
  const keys = (direction: Direction) =>
    policy[direction]
      .filter((rule) => rule.enabled && rule.action === "allow" && isWideRule(rule, direction))
      .map((rule) => `${direction}|${ruleValue(rule, direction).trim().toLowerCase()}|${rule.ports}|${rule.proto}`)
  return [...keys("outbound"), ...keys("inbound")]
}

// 与服务端 pendingRisks 一致：这些改动要先二次确认（自定义模式本身就是放开，不再逐条提示 wide）
export function policyRisks(before: NetworkPolicy, after: NetworkPolicy): Array<"custom" | "publicBind" | "wide"> {
  const risks: Array<"custom" | "publicBind" | "wide"> = []
  if (after.preset === "custom" && before.preset !== "custom") risks.push("custom")
  const hadWide = new Set(wideKeys(before))
  if (after.preset !== "custom" && wideKeys(after).some((key) => !hadWide.has(key))) risks.push("wide")
  const had = new Set(before.expose.filter((e) => !isLoopbackBind(e.bind)).map((e) => `${e.bind}:${e.hostPort}`))
  if (after.expose.some((e) => !isLoopbackBind(e.bind) && !had.has(`${e.bind}:${e.hostPort}`))) risks.push("publicBind")
  return risks
}

// ---- 规则表用的对象目录、模式默认行、校验与模糊匹配 ----

/** 变量：左边是写法，右边是说明（顺序“从容器往外”） */
export const OUTBOUND_VARS: Array<[string, string]> = [
  ["@containers", "其他容器"],
  ["@host", "宿主机"],
  ["@private", "内网"],
  ["@public", "公网"],
  ["@metadata", "云服务器元数据"],
  ["@any", "任何地址"],
]
export const INBOUND_VARS: Array<[string, string]> = [
  ["@containers", "其他容器"],
  ["@host", "宿主机（含端口暴露）"],
  ["@any", "任何来源"],
]
const SYSTEM_VARS: Record<string, string> = {
  "@cont_local": "容器本机",
  "@manyoyo": "DNS、代理、浏览器、软件源",
}

export type LockedRule = { action: Action; target: string; why: string }
const DEFAULT_WHY = "模式默认：切换上方模式会改变这些行；要例外就在上面加规则"

export const OUTBOUND_TOP: LockedRule[] = [
  { action: "allow", target: "@cont_local", why: "容器本机始终允许" },
  { action: "allow", target: "@manyoyo", why: "manyoyo 自身需要：DNS、上游代理、浏览器、软件源" },
]
export const INBOUND_TOP: LockedRule[] = [{ action: "allow", target: "@cont_local", why: "容器本机始终允许" }]

export function modeDefaultRules(direction: Direction, preset: Preset): LockedRule[] {
  const rows: Array<[Action, string]> =
    direction === "outbound"
      ? preset === "restricted"
        ? [["deny", "@containers"], ["deny", "@host"], ["deny", "@private"], ["deny", "@metadata"], ["allow", "@public"]]
        : preset === "allowlist"
          ? [["deny", "@any"]]
          : []
      : preset === "custom"
        ? []
        : [["deny", "@containers"], ["allow", "@host"]]
  return rows.map(([action, target]) => ({ action, target, why: DEFAULT_WHY }))
}

export const PRESET_LABELS: Record<Preset, string> = {
  restricted: "收紧（默认）",
  allowlist: "仅白名单",
  custom: "自定义",
}

export const PRESET_HINTS: Record<Preset, string> = {
  restricted: "可以上公网；访问其他容器、宿主机和内网需要在上面放行。",
  allowlist: "只能访问上面允许的目标，其余一律拒绝。",
  custom: "完全按你的规则，没有匹配的一律允许。",
}

export type PeerOption = { id: string; name: string; running: boolean; ip?: string }
export type DerivedRule = { id: string; name: string; ip: string; ports: string; proto: Proto }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/
const IPV6_RE = /^[0-9a-f:]*:[0-9a-f:.]*(\/\d{1,3})?$/i
const CONTAINER_PREFIX = "@container:"

/** 说明文字：变量 → 一句话；容器 → IP / 未运行；写错了返回空串 */
export function describeTarget(value: string, containers?: PeerOption[], direction: Direction = "outbound"): string {
  const text = value.trim()
  if (SYSTEM_VARS[text]) return SYSTEM_VARS[text]
  const found = (direction === "inbound" ? [...INBOUND_VARS, ...OUTBOUND_VARS] : [...OUTBOUND_VARS, ...INBOUND_VARS]).find(([key]) => key === text)
  if (found) return found[1]
  if (text.startsWith(CONTAINER_PREFIX)) {
    const ref = text.slice(CONTAINER_PREFIX.length)
    const hit = containers?.find((c) => c.id === ref || c.name === ref)
    if (!containers) return ""
    return hit ? (hit.running ? hit.ip || "运行中" : "未运行") : "已删除的容器"
  }
  return ""
}

/** 目标 / 来源的写法检查；返回一句话错误，没问题返回空串。容器列表未知（新建容器）时不查容器是否存在 */
export function validateTarget(value: string, direction: Direction, containers?: PeerOption[]): string {
  const text = value.trim()
  if (!text) return direction === "outbound" ? "请填写目标" : "请填写来源"
  if (text === "@cont_local" || text === "@manyoyo") return "这一项始终允许，不需要写"
  if (text.startsWith("@")) {
    const vars = direction === "outbound" ? OUTBOUND_VARS : INBOUND_VARS
    if (vars.some(([key]) => key === text)) return ""
    if (text.startsWith(CONTAINER_PREFIX)) {
      const ref = text.slice(CONTAINER_PREFIX.length)
      if (!ref) return "请选择容器"
      if (containers && !containers.some((c) => c.id === ref || c.name === ref)) return "没有这个容器"
      return NAME_RE.test(ref) ? "" : "容器名称写法不对"
    }
    return `不认识的对象 ${text}，输入 @ 查看可选项`
  }
  if (IPV4_RE.test(text)) {
    const [addr, prefix] = text.split("/")
    const ok = addr.split(".").every((part) => Number(part) <= 255) && (prefix === undefined || Number(prefix) <= 32)
    return ok ? "" : "IP 写法不对"
  }
  if (IPV6_RE.test(text)) return ""
  if (direction === "outbound" && DOMAIN_RE.test(text)) return ""
  return direction === "inbound" ? "来源只能是 IP、网段或 @ 对象" : "请填写域名、IP、网段或 @ 对象"
}

export function validatePorts(ports: string): string {
  const text = ports.replace(/\s+/g, "")
  if (!text) return ""
  const ok = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(text) &&
    text.split(",").every((item) => {
      const [a, b] = item.split("-").map(Number)
      return a >= 1 && a <= 65535 && (b === undefined || (b >= a && b <= 65535))
    })
  return ok ? "" : "端口写法：443、8000-8100 或 80,443"
}

export function isDomainTarget(value: string): boolean {
  const text = value.trim()
  return !!text && !text.startsWith("@") && !IPV4_RE.test(text) && !IPV6_RE.test(text) && DOMAIN_RE.test(text)
}

/** 域名规则只看 tcp：udp 的域名规则服务端不收 */
export function validateRule(rule: Rule, direction: Direction, containers?: PeerOption[]): string {
  const value = ruleValue(rule, direction)
  if (!value.trim()) return ""
  return (
    validateTarget(value, direction, containers) ||
    validatePorts(rule.ports) ||
    (direction === "outbound" && isDomainTarget(value) && rule.proto === "udp" ? "域名规则只支持 tcp" : "")
  )
}

export function policyProblems(policy: NetworkPolicy, containers?: PeerOption[]): string[] {
  const out: string[] = []
  ;(["outbound", "inbound"] as Direction[]).forEach((direction) =>
    policy[direction].forEach((rule) => {
      const message = validateRule(rule, direction, containers)
      if (message) out.push(message)
    })
  )
  return out
}

/** 子序列模糊匹配：连续命中得分更高；返回命中下标（用于高亮） */
export function fuzzyMatch(query: string, text: string): { score: number; hit: number[] } | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hit: number[] = []
  let qi = 0
  let score = 0
  let last = -2
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      hit.push(i)
      score += i === last + 1 ? 3 : 1
      last = i
      qi++
    }
  }
  return qi === q.length ? { score: score - t.length * 0.01, hit } : null
}

export type Candidate = { value: string; desc: string; group: "预设对象" | "容器"; hit: number[] }

/** 输入 `@xxx` 时的候选：query 是 @ 之后的内容；空串列出全部 */
export function targetCandidates(direction: Direction, query: string, containers: PeerOption[]): Candidate[] {
  const vars = (direction === "outbound" ? OUTBOUND_VARS : INBOUND_VARS).map(([value, desc]) => ({ value, desc, group: "预设对象" as const }))
  const cs = containers.map((c) => ({
    value: `${CONTAINER_PREFIX}${c.name}`,
    desc: c.running ? c.ip || "运行中" : "未运行",
    group: "容器" as const,
  }))
  const all = [...vars, ...cs]
  if (!query) return all.map((item) => ({ ...item, hit: [] }))
  const scored: Array<Candidate & { score: number }> = []
  for (const item of all) {
    const m = fuzzyMatch(query, item.value.slice(1))
    if (m) scored.push({ ...item, hit: m.hit, score: m.score })
    else if (fuzzyMatch(query, item.desc)) scored.push({ ...item, hit: [], score: 0 })
  }
  return scored.sort((a, b) => b.score - a.score).map((item) => ({ value: item.value, desc: item.desc, group: item.group, hit: item.hit }))
}

/** 把 `@container:<名称>` 换成 id（服务端存 id）；名称对不上就原样返回 */
export function containerRefToId(value: string, containers: PeerOption[]): string {
  const text = value.trim()
  if (!text.startsWith(CONTAINER_PREFIX)) return text
  const ref = text.slice(CONTAINER_PREFIX.length)
  if (containers.some((c) => c.id === ref)) return text
  const named = containers.filter((c) => c.name === ref)
  return named.length === 1 ? `${CONTAINER_PREFIX}${named[0].id}` : text
}

/** 输入框里显示名称而不是 id */
export function containerRefToName(value: string, containers: PeerOption[]): string {
  if (!value.startsWith(CONTAINER_PREFIX)) return value
  const hit = containers.find((c) => c.id === value.slice(CONTAINER_PREFIX.length))
  return hit ? `${CONTAINER_PREFIX}${hit.name}` : value
}

export type NetStatus = { status: "applied" | "error" | "unsupported"; message?: string; warning?: string; at?: string } | null

export function describeNetStatus(status: NetStatus, running: boolean): { label: string; tone: "ok" | "danger" | "warn" } {
  if (!running) return { label: "容器未运行，下次启动时下发", tone: "warn" }
  if (!status) return { label: "尚未下发", tone: "warn" }
  if (status.status === "applied") return { label: "已生效", tone: "ok" }
  if (status.status === "unsupported") return { label: status.message || "此网络模式不支持", tone: "warn" }
  return { label: status.message || "下发失败", tone: "danger" }
}

export type EnvFileStatus = {
  path: string
  exists: boolean
  error: string
  count: number
  invalid: EnvInvalid[]
}

export type ContainerEnvState = {
  legacy?: boolean
  message?: string
  id?: string
  warning?: string
  text: string
  entries: EnvEntry[]
  invalid: EnvInvalid[]
  files: EnvFileStatus[]
  etag: string
  mtime: string | null
}

export type DeniedRecord = { host: string; port: number; count: number; last: string; reason: string; background: boolean }

export type NetworkState = {
  legacy?: boolean
  message?: string
  id: string
  running: boolean
  policy: NetworkPolicy
  status: NetStatus
  forwards: Array<{ bind: string; hostPort: number; port: number }>
  suggestedDomains?: string[]
  denied?: DeniedRecord[]
  peers: PeerOption[]
  derived?: DerivedRule[]
  unrestricted?: boolean
}
