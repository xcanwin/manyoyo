import { describe, expect, test } from "vitest"

import {
  type NetworkPolicy,
  type Rule,
  containerRefToId,
  containerRefToName,
  defaultPolicy,
  describeNetStatus,
  describeTarget,
  fuzzyMatch,
  isShadowingRule,
  isSensitiveKey,
  isUnrestricted,
  modeDefaultRules,
  moveRule,
  networkForCreate,
  parseEnvText,
  policyProblems,
  policyRisks,
  removeRule,
  samePolicy,
  serializeEnv,
  switchPreset,
  targetCandidates,
  toggleRule,
  validatePorts,
  validateRule,
  validateTarget,
} from "./container-manage"

// 与 test/env-text.test.js 同一组语料（服务端 node 实现、容器内 bash 实现都对照过）
const CORPUS: Array<[string, Record<string, string>]> = [
  ["CMT_A=1", { CMT_A: "1" }],
  ["CMT_SP=abc 123", { CMT_SP: "abc 123" }],
  ['CMT_Q="abc 123"', { CMT_Q: "abc 123" }],
  ["CMT_SQ='abc 123'", { CMT_SQ: "abc 123" }],
  ["export CMT_E=1", { CMT_E: "1" }],
  ["export   CMT_E2 = two ", { CMT_E2: "two" }],
  ["CMT_SPACES = a b ", { CMT_SPACES: "a b" }],
  ['CMT_KEEP="  padded  "', { CMT_KEEP: "  padded  " }],
  ["CMT_EMPTY=", { CMT_EMPTY: "" }],
  ["CMT_EQ=a=b=c", { CMT_EQ: "a=b=c" }],
  ['CMT_ONEQ="abc', { CMT_ONEQ: '"abc' }],
  ["CMT_MIX=\"a'", { CMT_MIX: "\"a'" }],
  ["CMT_NESTED='\"x\"'", { CMT_NESTED: '"x"' }],
  ["CMT_URL=http://h:1/?a=1&b=2", { CMT_URL: "http://h:1/?a=1&b=2" }],
  ["CMT_DOLLAR=$HOME `id` $(id)", { CMT_DOLLAR: "$HOME `id` $(id)" }],
  ["# comment", {}],
  ["   # indented comment", {}],
  ["", {}],
  ["1BAD=x", {}],
  ["BAD KEY=x", {}],
  ["noequals", {}],
]

describe("env 文本", () => {
  test.each(CORPUS)("语料：%s", (line, expected) => {
    const parsed = parseEnvText(line)
    expect(Object.fromEntries(parsed.entries.map((entry) => [entry.key, entry.value]))).toEqual(expected)
  })

  test("非法行带行号单独报出", () => {
    const parsed = parseEnvText("A=1\n1BAD=x\n# c\nnoequals\n")
    expect(parsed.invalid.map((item) => item.line)).toEqual([2, 4])
  })

  test("serializeEnv：空 key 丢掉；只在首尾空白或首尾恰好一对引号时加引号，且能原样读回", () => {
    expect(serializeEnv([{ key: "A", value: "1" }, { key: " ", value: "x" }, { key: "S", value: "abc 123" }])).toBe("A=1\nS=abc 123\n")
    expect(serializeEnv([])).toBe("")
    for (const value of ["abc", "abc 123", " lead", "trail ", '"x"', "'x'", '"', "it's", "", "a=b", "\"a'", "'\"y\"'"]) {
      expect(parseEnvText(serializeEnv([{ key: "K", value }])).entries).toEqual([{ key: "K", value }])
    }
  })

  test("敏感 key 判断", () => {
    expect(["OPENAI_API_KEY", "gh_token", "DB_PASSWORD", "MY_SECRET", "AUTH_HEADER"].every(isSensitiveKey)).toBe(true)
    expect(["PATH", "LANG", "HTTP_PROXY"].some(isSensitiveKey)).toBe(false)
  })
})

const rule = (action: "allow" | "deny", target: string, extra: Partial<Rule> = {}): Rule => ({ action, target, ports: "", proto: "all", enabled: true, ...extra })
const inRule = (action: "allow" | "deny", source: string, extra: Partial<Rule> = {}): Rule => ({ action, source, ports: "", proto: "tcp", enabled: true, ...extra })
const withOut = (...rules: Rule[]): NetworkPolicy => ({ ...defaultPolicy(), outbound: rules })

describe("风险与状态", () => {
  test("切到自定义、新增非本机绑定需要确认；本机绑定与已有绑定不需要", () => {
    const before = defaultPolicy()
    expect(policyRisks(before, { ...before, preset: "custom" })).toEqual(["custom"])
    expect(policyRisks({ ...before, preset: "custom" }, { ...before, preset: "custom" })).toEqual([])
    const local = { ...before, expose: [{ bind: "127.0.0.1", hostPort: 18080, port: 80 }] }
    expect(policyRisks(before, local)).toEqual([])
    const wide = { ...before, expose: [{ bind: "0.0.0.0", hostPort: 18080, port: 80 }] }
    expect(policyRisks(before, wide)).toEqual(["publicBind"])
    expect(policyRisks(wide, wide)).toEqual([])
  })

  test("新增启用的宽允许规则需要确认；窄规则、拒绝行、暂停行、已有的不需要", () => {
    const base = defaultPolicy()
    for (const target of ["@any", "@private", "@metadata", "10.0.0.0/8", "0.0.0.0/0", "@host", "*.co.uk"]) {
      expect(policyRisks(base, withOut(rule("allow", target)))).toEqual(["wide"])
    }
    expect(policyRisks(base, withOut(rule("allow", "@host", { ports: "11434" })))).toEqual([])
    expect(policyRisks(base, withOut(rule("allow", "192.168.1.50", { ports: "8000" })))).toEqual([])
    expect(policyRisks(base, withOut(rule("allow", "*.example.com")))).toEqual([])
    expect(policyRisks(base, withOut(rule("deny", "@any")))).toEqual([])
    expect(policyRisks(base, withOut(rule("allow", "@any", { enabled: false })))).toEqual([])
    const had = withOut(rule("allow", "@private"))
    expect(policyRisks(had, had)).toEqual([])
    expect(policyRisks(base, { ...base, inbound: [inRule("allow", "@containers")] })).toEqual(["wide"])
    expect(policyRisks(base, { ...base, inbound: [inRule("allow", "@container:abc", { ports: "7000" })] })).toEqual([])
  })

  test("下发状态文案", () => {
    expect(describeNetStatus(null, false).tone).toBe("warn")
    expect(describeNetStatus({ status: "applied" }, true)).toEqual({ label: "已生效", tone: "ok" })
    expect(describeNetStatus({ status: "error", message: "boom" }, true)).toEqual({ label: "boom", tone: "danger" })
  })
})

describe("新建容器的 network", () => {
  test("与默认相同不发（空行不算）；有改动才发，且不带 autostartOnServe", () => {
    expect(networkForCreate(defaultPolicy())).toBeUndefined()
    expect(networkForCreate({ ...defaultPolicy(), autostartOnServe: true })).toBeUndefined()
    expect(networkForCreate(withOut(rule("allow", "  ")))).toBeUndefined()
    const sent = networkForCreate({ ...defaultPolicy(), preset: "custom", autostartOnServe: true })
    expect(sent).toEqual(expect.objectContaining({ preset: "custom", version: 2 }))
    expect(sent).not.toHaveProperty("autostartOnServe")
    expect(networkForCreate(withOut(rule("allow", " github.com ", { ports: "443, 80" })))?.outbound).toEqual([rule("allow", "github.com", { ports: "443,80" })])
  })
})

describe("规则操作", () => {
  const a = rule("allow", "a.com")
  const b = rule("deny", "b.com")
  const c = rule("allow", "c.com")

  test("上移 / 下移：边界不动", () => {
    expect(moveRule([a, b, c], 1, -1)).toEqual([b, a, c])
    expect(moveRule([a, b, c], 1, 1)).toEqual([a, c, b])
    expect(moveRule([a, b, c], 0, -1)).toEqual([a, b, c])
    expect(moveRule([a, b, c], 2, 1)).toEqual([a, b, c])
  })

  test("暂停 / 恢复、删除", () => {
    expect(toggleRule([a, b], 1)[1].enabled).toBe(false)
    expect(toggleRule(toggleRule([a, b], 1), 1)[1].enabled).toBe(true)
    expect(removeRule([a, b, c], 1)).toEqual([a, c])
  })

  test("切换模式：用户规则保留", () => {
    const policy = withOut(a, b)
    const next = switchPreset(policy, "allowlist")
    expect(next.preset).toBe("allowlist")
    expect(next.outbound).toEqual([a, b])
    expect(switchPreset(next, "restricted").outbound).toEqual([a, b])
  })

  test("进入自定义：出入站各加一行允许 @any；离开时删掉没改过的那行，其他规则保留", () => {
    const entered = switchPreset(withOut(a), "custom")
    expect(entered.outbound).toEqual([a, rule("allow", "@any")])
    expect(entered.inbound).toEqual([inRule("allow", "@any", { proto: "all" })])
    const left = switchPreset(entered, "restricted")
    expect(left.outbound).toEqual([a])
    expect(left.inbound).toEqual([])
    // 用户改过的行（带端口）不删
    const edited = { ...entered, outbound: [a, rule("allow", "@any", { ports: "80" })] }
    expect(switchPreset(edited, "allowlist").outbound).toEqual(edited.outbound)
  })

  test("isUnrestricted：自定义且只有允许 @any", () => {
    expect(isUnrestricted(defaultPolicy())).toBe(false)
    expect(isUnrestricted(switchPreset(defaultPolicy(), "custom"))).toBe(true)
    expect(isUnrestricted({ ...defaultPolicy(), preset: "custom" })).toBe(true)
    const custom = switchPreset(defaultPolicy(), "custom")
    expect(isUnrestricted({ ...custom, outbound: [...custom.outbound, rule("deny", "x.com")] })).toBe(false)
    expect(isUnrestricted({ ...custom, outbound: [...custom.outbound, rule("deny", "x.com", { enabled: false })] })).toBe(true)
  })

  test("模式默认行与锁定行", () => {
    expect(modeDefaultRules("outbound", "restricted").map((r) => `${r.action} ${r.target}`)).toEqual([
      "deny @containers", "deny @host", "deny @private", "deny @metadata", "allow @public",
    ])
    expect(modeDefaultRules("outbound", "allowlist").map((r) => r.target)).toEqual(["@any"])
    expect(modeDefaultRules("outbound", "custom")).toEqual([])
    expect(modeDefaultRules("inbound", "restricted").map((r) => `${r.action} ${r.target}`)).toEqual(["deny @containers", "allow @host"])
    expect(modeDefaultRules("inbound", "custom")).toEqual([])
  })

  test("非自定义模式下启用的“允许 @any”标记为遮蔽下面的规则", () => {
    expect(isShadowingRule(rule("allow", "@any"), "outbound", "restricted")).toBe(true)
    expect(isShadowingRule(rule("allow", "@any"), "outbound", "custom")).toBe(false)
    expect(isShadowingRule(rule("allow", "@any", { enabled: false }), "outbound", "restricted")).toBe(false)
  })
})

describe("校验与模糊匹配", () => {
  const peers = [
    { id: "0123456789abcdef", name: "my-web", running: true, ip: "10.89.0.5" },
    { id: "fedcba9876543210", name: "my-db", running: false },
  ]

  test("目标写法：变量、IP、网段、域名；入站不收域名；系统变量不能写", () => {
    expect(validateTarget("@host", "outbound")).toBe("")
    expect(validateTarget("@public", "inbound")).not.toBe("")
    expect(validateTarget("@manyoyo", "outbound")).toContain("始终允许")
    expect(validateTarget("@cont_local", "outbound")).toContain("始终允许")
    expect(validateTarget("@nope", "outbound")).toContain("不认识")
    expect(validateTarget("192.168.1.50", "outbound")).toBe("")
    expect(validateTarget("10.0.0.0/8", "inbound")).toBe("")
    expect(validateTarget("300.1.1.1", "outbound")).not.toBe("")
    expect(validateTarget("*.example.com", "outbound")).toBe("")
    expect(validateTarget("example.com", "inbound")).not.toBe("")
    expect(validateTarget("", "outbound")).not.toBe("")
  })

  test("@container：名称或 id 都认，容器列表未知时不查", () => {
    expect(validateTarget("@container:my-web", "outbound", peers)).toBe("")
    expect(validateTarget("@container:0123456789abcdef", "inbound", peers)).toBe("")
    expect(validateTarget("@container:gone", "outbound", peers)).toBe("没有这个容器")
    expect(validateTarget("@container:gone", "outbound")).toBe("")
    expect(describeTarget("@container:my-web", peers)).toBe("10.89.0.5")
    expect(describeTarget("@container:my-db", peers)).toBe("未运行")
    expect(describeTarget("@container:gone", peers)).toBe("已删除的容器")
    expect(containerRefToId("@container:my-web", peers)).toBe("@container:0123456789abcdef")
    expect(containerRefToName("@container:0123456789abcdef", peers)).toBe("@container:my-web")
    expect(containerRefToName("@container:zzzz", peers)).toBe("@container:zzzz")
  })

  test("端口与域名规则的协议", () => {
    expect(["", "443", "8000-8100", "80,443"].map(validatePorts)).toEqual(["", "", "", ""])
    expect(validatePorts("0")).not.toBe("")
    expect(validatePorts("90-80")).not.toBe("")
    expect(validatePorts("abc")).not.toBe("")
    expect(validateRule(rule("allow", "x.com", { proto: "udp" }), "outbound")).toContain("tcp")
    expect(validateRule(rule("allow", "1.2.3.4", { proto: "udp" }), "outbound")).toBe("")
    expect(policyProblems(withOut(rule("allow", "@nope")))).toHaveLength(1)
    expect(policyProblems(withOut(rule("allow", "")))).toEqual([])
  })

  test("模糊匹配：子序列、连续命中得分高、高亮下标", () => {
    expect(fuzzyMatch("xyz", "host")).toBeNull()
    expect(fuzzyMatch("ho", "host")?.hit).toEqual([0, 1])
    expect((fuzzyMatch("con", "containers")?.score ?? 0)).toBeGreaterThan(fuzzyMatch("cns", "containers")?.score ?? 0)
  })

  test("候选：@ 后为空列全部；按输入过滤；容器带 IP / 未运行", () => {
    const all = targetCandidates("outbound", "", peers)
    expect(all.map((c) => c.value)).toEqual(["@containers", "@host", "@private", "@public", "@metadata", "@any", "@container:my-web", "@container:my-db"])
    expect(targetCandidates("inbound", "", peers).map((c) => c.value)).toEqual(["@containers", "@host", "@any", "@container:my-web", "@container:my-db"])
    expect(targetCandidates("outbound", "ho", peers)[0].value).toBe("@host")
    const web = targetCandidates("outbound", "web", peers)
    expect(web).toEqual([expect.objectContaining({ value: "@container:my-web", desc: "10.89.0.5", group: "容器" })])
    expect(targetCandidates("outbound", "my-d", peers)[0].desc).toBe("未运行")
    expect(targetCandidates("outbound", "zzz", peers)).toEqual([])
  })
})

describe("samePolicy", () => {
  test("规则键顺序不同也算相同（保存后不应一直显示未保存）；内容不同才算不同", () => {
    const server = { ...defaultPolicy(), outbound: [{ action: "allow", target: "@host", ports: "80", proto: "all", enabled: true }] } as NetworkPolicy
    const edited = { ...defaultPolicy(), outbound: [{ action: "allow", ports: "80", proto: "all", enabled: true, target: "@host" }] } as NetworkPolicy
    expect(samePolicy(edited, server)).toBe(true)
    expect(samePolicy({ ...edited, outbound: [{ ...edited.outbound[0], enabled: false }] }, server)).toBe(false)
  })
})
