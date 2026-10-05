// 容器管理（环境变量 / 自启动 / 网络）的类型与纯函数。语义与服务端 lib/container-state.js、
// lib/network-policy.js 保持一致：env 按第一个 = 切分、不去引号；策略的校验以服务端为准，这里只做编辑与展示。

export type EnvEntry = { key: string; value: string }
export type EnvInvalid = { line: number; text: string; reason: string }

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i

export function parseEnvText(text: string): { entries: EnvEntry[]; invalid: EnvInvalid[] } {
  const entries: EnvEntry[] = []
  const invalid: EnvInvalid[] = []
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "")
    if (!line.trim() || line.startsWith("#")) return
    const eq = line.indexOf("=")
    if (eq <= 0) {
      invalid.push({ line: index + 1, text: line, reason: "缺少 KEY=VALUE" })
      return
    }
    const key = line.slice(0, eq)
    if (!ENV_KEY_RE.test(key)) {
      invalid.push({ line: index + 1, text: line, reason: `key 非法: ${key}` })
      return
    }
    entries.push({ key, value: line.slice(eq + 1) })
  })
  return { entries, invalid }
}

export function serializeEnv(entries: EnvEntry[]): string {
  const lines = entries.filter((entry) => entry.key.trim()).map((entry) => `${entry.key.trim()}=${entry.value}`)
  return lines.length ? `${lines.join("\n")}\n` : ""
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key)
}

export type Proto = "tcp" | "udp"
export type Preset = "restricted" | "allowlist" | "open"
export type EgressRule = { cidr: string; ports: string; proto: Proto }
export type HostRule = { ports: string; proto: Proto }
export type PeerInbound = { from: string; ports: string; proto: Proto }
export type ExposeEntry = { bind: string; hostPort: number; port: number }

export type NetworkPolicy = {
  version: 1
  preset: Preset
  egress: { domains: string[]; rules: EgressRule[] }
  host: HostRule[]
  peers: { inbound: PeerInbound[] }
  deny: { cidr: string }[]
  expose: ExposeEntry[]
  autostartOnServe: boolean
}

export function defaultPolicy(): NetworkPolicy {
  return {
    version: 1,
    preset: "restricted",
    egress: { domains: [], rules: [] },
    host: [],
    peers: { inbound: [] },
    deny: [],
    expose: [],
    autostartOnServe: false,
  }
}

// 新建容器时要发给服务端的 network：与默认（收紧、无规则）相同就不发，交给 runs / 全局配置与服务端默认
// autostartOnServe 单独走自己的字段，不在 network 里
export function networkForCreate(policy: NetworkPolicy): Omit<NetworkPolicy, "autostartOnServe"> | undefined {
  const rest: Partial<NetworkPolicy> = { ...policy }
  delete rest.autostartOnServe
  const base: Partial<NetworkPolicy> = defaultPolicy()
  delete base.autostartOnServe
  return JSON.stringify(rest) === JSON.stringify(base) ? undefined : (rest as Omit<NetworkPolicy, "autostartOnServe">)
}

export function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1"
}

const PUBLIC_SUFFIX_WILDCARD_RE = /^\*\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/

function isWideRule(cidr: string): boolean {
  const match = /\/(\d+)$/.exec(cidr)
  const prefix = match ? Number(match[1]) : 32
  return cidr.includes(":") ? prefix <= 16 : prefix <= 8
}

function wideKeys(policy: NetworkPolicy): string[] {
  return [
    ...policy.egress.rules.filter((rule) => isWideRule(rule.cidr)).map((rule) => `rule:${rule.cidr}|${rule.ports}|${rule.proto}`),
    ...policy.egress.domains.filter((domain) => PUBLIC_SUFFIX_WILDCARD_RE.test(domain)).map((domain) => `domain:${domain}`),
  ]
}

// 与服务端 pendingRisks 一致：这些改动要先二次确认
export function policyRisks(before: NetworkPolicy, after: NetworkPolicy): Array<"open" | "publicBind" | "wide"> {
  const risks: Array<"open" | "publicBind" | "wide"> = []
  if (after.preset === "open" && before.preset !== "open") risks.push("open")
  const hadWide = new Set(wideKeys(before))
  if (after.preset !== "open" && wideKeys(after).some((key) => !hadWide.has(key))) risks.push("wide")
  const had = new Set(before.expose.filter((e) => !isLoopbackBind(e.bind)).map((e) => `${e.bind}:${e.hostPort}`))
  if (after.expose.some((e) => !isLoopbackBind(e.bind) && !had.has(`${e.bind}:${e.hostPort}`))) risks.push("publicBind")
  return risks
}

export type NetStatus = { status: "applied" | "error" | "unsupported"; message?: string; warning?: string; at?: string } | null

export function describeNetStatus(status: NetStatus, running: boolean): { label: string; tone: "ok" | "danger" | "warn" } {
  if (!running) return { label: "容器未运行，下次启动时下发", tone: "warn" }
  if (!status) return { label: "尚未下发", tone: "warn" }
  if (status.status === "applied") return { label: "已生效", tone: "ok" }
  if (status.status === "unsupported") return { label: status.message || "此网络模式不支持", tone: "warn" }
  return { label: status.message || "下发失败", tone: "danger" }
}

export const PRESET_LABELS: Record<Preset, string> = {
  restricted: "收紧（默认）",
  allowlist: "仅白名单",
  open: "开放",
}

export const PRESET_HINTS: Record<Preset, string> = {
  restricted: "允许公网；禁止宿主机其他端口、局域网 / 私有网段、云元数据与其他容器。manyoyo 必需的端点（DNS、上游代理、Playwright、镜像源）自动放行。",
  allowlist: "只允许访问下列域名（经 serve 内的过滤代理）与 IP 规则，其余出站一律拒绝。",
  open: "不加任何网络规则（与旧版行为一致），容器可访问宿主机与局域网。",
}

export type PeerOption = { id: string; name: string; running: boolean }

export type ContainerEnvState = {
  legacy?: boolean
  message?: string
  id?: string
  warning?: string
  text: string
  entries: EnvEntry[]
  invalid: EnvInvalid[]
  etag: string
  mtime: string | null
}

export type NetworkState = {
  legacy?: boolean
  message?: string
  id: string
  running: boolean
  policy: NetworkPolicy
  status: NetStatus
  forwards: Array<{ bind: string; hostPort: number; port: number }>
  peers: PeerOption[]
}
