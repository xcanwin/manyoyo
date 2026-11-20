// 地址识别候选（服务端 lib/network-infer.js 的形状）与“勾选后合并进出站规则”的纯函数。
// 只做展示与合并；识别、风险分级、DNS 都在服务端。

import { newRule, type NetworkPolicy, type Rule } from "./container-manage"

export type EndpointRisk = "" | "private" | "metadata" | "wide"

export type EndpointCandidate = {
  id: string
  kind: "domain" | "cidr" | "host"
  target: string
  ports: string
  proto: "tcp" | "all"
  sources: Array<"autostart" | "first" | "first.env" | "first.envFile">
  evidence: string
  resolved: string[]
  risk: EndpointRisk
  defaultChecked: boolean
}

export type InferResponse = {
  candidates: EndpointCandidate[]
  truncated: boolean
  preset: "restricted" | "allowlist" | "custom"
  reason?: string
}

export type NewContainerPreset = {
  run: string
  autostart: string
  autostartOnServe: boolean
  network: NetworkPolicy
}

const keyOf = (target: string, ports: string, proto: string) => `allow|${target}|${ports}|${proto}`

/**
 * 把勾选的候选合并进出站允许规则（插到最前，保持候选顺序）。
 * 域名候选同时补上它解析出来的私有地址（过滤代理看域名，不走代理的工具看 IP）。
 * 已存在完全相同的允许规则（action|target|ports|proto）就跳过；用户自己的规则顺序不变。
 */
export function mergeSelectedCandidates(
  policy: NetworkPolicy,
  candidates: EndpointCandidate[],
  selectedIds: ReadonlySet<string>
): NetworkPolicy {
  const selected = candidates.filter((candidate) => selectedIds.has(candidate.id))
  if (!selected.length) return policy
  const existing = new Set(
    policy.outbound
      .filter((rule) => rule.action === "allow")
      .map((rule) => keyOf(rule.target ?? "", rule.ports, rule.proto))
  )
  const inserted: Rule[] = []
  const push = (target: string, ports: string, proto: Rule["proto"]) => {
    const key = keyOf(target, ports, proto)
    if (existing.has(key)) return
    existing.add(key)
    inserted.push(newRule("outbound", target, { ports, proto }))
  }
  for (const candidate of selected) {
    if (candidate.kind === "domain") {
      push(candidate.target, candidate.ports, candidate.proto)
      candidate.resolved.forEach((ip) => push(ip, candidate.ports, candidate.proto))
    } else if (candidate.kind === "cidr") {
      push(candidate.target, candidate.ports, candidate.proto)
    } else {
      push(candidate.target, candidate.ports, candidate.proto)
    }
  }
  if (!inserted.length) return policy
  return { ...policy, outbound: [...inserted, ...policy.outbound] }
}
