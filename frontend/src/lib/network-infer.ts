// 地址列表（形状与服务端 lib/network-infer.js 一致）和“勾选后加入进出站规则”的纯函数。
// 这里只负责展示和合并；识别、风险分类、DNS 都在服务端。

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
 * 把勾选的地址加入出站允许规则（插到最前，保持列表里的顺序）。
 * 域名还会同时补上它解析出来的私有地址（过滤代理看域名，不走代理的工具看 IP）。
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
