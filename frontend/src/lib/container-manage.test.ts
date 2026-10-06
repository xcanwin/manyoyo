import { describe, expect, test } from "vitest"

import {
  defaultPolicy,
  describeNetStatus,
  isSensitiveKey,
  networkForCreate,
  parseEnvText,
  policyRisks,
  serializeEnv,
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

describe("风险与状态", () => {
  test("切到 open、新增非本机绑定需要确认；本机绑定与已有绑定不需要", () => {
    const before = defaultPolicy()
    expect(policyRisks(before, { ...before, preset: "open" })).toEqual(["open"])
    expect(policyRisks({ ...before, preset: "open" }, { ...before, preset: "open" })).toEqual([])
    const local = { ...before, expose: [{ bind: "127.0.0.1", hostPort: 18080, port: 80 }] }
    expect(policyRisks(before, local)).toEqual([])
    const wide = { ...before, expose: [{ bind: "0.0.0.0", hostPort: 18080, port: 80 }] }
    expect(policyRisks(before, wide)).toEqual(["publicBind"])
    expect(policyRisks(wide, wide)).toEqual([])
  })

  test("极宽的出站规则需要确认（/8 以上网段、公共后缀通配），窄规则不需要", () => {
    const base = defaultPolicy()
    const rule = (cidr: string) => ({ ...base, egress: { domains: [], rules: [{ cidr, ports: "", proto: "tcp" as const }] } })
    expect(policyRisks(base, rule("0.0.0.0/0"))).toEqual(["wide"])
    expect(policyRisks(base, rule("10.0.0.0/8"))).toEqual(["wide"])
    expect(policyRisks(base, rule("192.168.1.50"))).toEqual([])
    expect(policyRisks(base, { ...base, preset: "allowlist", egress: { domains: ["*.co.uk"], rules: [] } })).toEqual(["wide"])
    expect(policyRisks(base, { ...base, preset: "allowlist", egress: { domains: ["*.example.com"], rules: [] } })).toEqual([])
  })

  test("下发状态文案", () => {
    expect(describeNetStatus(null, false).tone).toBe("warn")
    expect(describeNetStatus({ status: "applied" }, true)).toEqual({ label: "已生效", tone: "ok" })
    expect(describeNetStatus({ status: "error", message: "boom" }, true)).toEqual({ label: "boom", tone: "danger" })
  })
})

describe("新建容器的 network", () => {
  test("与默认相同不发；有改动才发，且不带 autostartOnServe", () => {
    expect(networkForCreate(defaultPolicy())).toBeUndefined()
    expect(networkForCreate({ ...defaultPolicy(), autostartOnServe: true })).toBeUndefined()
    const sent = networkForCreate({ ...defaultPolicy(), preset: "open", autostartOnServe: true })
    expect(sent).toEqual(expect.objectContaining({ preset: "open" }))
    expect(sent).not.toHaveProperty("autostartOnServe")
  })
})
