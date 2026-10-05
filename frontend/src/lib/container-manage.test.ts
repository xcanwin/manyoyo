import { describe, expect, test } from "vitest"

import {
  defaultPolicy,
  describeNetStatus,
  formatHostLines,
  formatRuleLines,
  isSensitiveKey,
  networkForCreate,
  parseEnvText,
  parseHostLines,
  parseRuleLines,
  policyRisks,
  serializeEnv,
} from "./container-manage"

describe("env 文本", () => {
  test("按第一个 = 切分、不去引号、跳过注释；非法行单独报出", () => {
    const parsed = parseEnvText('A=1\n# c\n\nQ="a b"\nE=x=y\n1BAD=x\nnoequals\n')
    expect(parsed.entries).toEqual([
      { key: "A", value: "1" },
      { key: "Q", value: '"a b"' },
      { key: "E", value: "x=y" },
    ])
    expect(parsed.invalid.map((item) => item.line)).toEqual([6, 7])
  })

  test("serializeEnv 丢掉空 key，保留值里的引号", () => {
    expect(serializeEnv([{ key: "A", value: "1" }, { key: " ", value: "x" }, { key: "Q", value: '"a b"' }])).toBe('A=1\nQ="a b"\n')
    expect(serializeEnv([])).toBe("")
  })

  test("敏感 key 判断", () => {
    expect(["OPENAI_API_KEY", "gh_token", "DB_PASSWORD", "MY_SECRET", "AUTH_HEADER"].every(isSensitiveKey)).toBe(true)
    expect(["PATH", "LANG", "HTTP_PROXY"].some(isSensitiveKey)).toBe(false)
  })
})

describe("网络规则文本", () => {
  test("宿主机端口行往返", () => {
    const host = parseHostLines("18601\n5353/udp\n 80,443 \n")
    expect(host).toEqual([
      { ports: "18601", proto: "tcp" },
      { ports: "5353", proto: "udp" },
      { ports: "80,443", proto: "tcp" },
    ])
    expect(formatHostLines(host)).toBe("18601\n5353/udp\n80,443")
  })

  test("出站规则行：CIDR [端口] [协议]", () => {
    const rules = parseRuleLines("140.82.112.0/20 22,443 tcp\n10.0.0.5\n8.8.8.0/24 53 udp")
    expect(rules).toEqual([
      { cidr: "140.82.112.0/20", ports: "22,443", proto: "tcp" },
      { cidr: "10.0.0.5", ports: "", proto: "tcp" },
      { cidr: "8.8.8.0/24", ports: "53", proto: "udp" },
    ])
    expect(formatRuleLines(rules)).toBe("140.82.112.0/20 22,443\n10.0.0.5\n8.8.8.0/24 53 udp")
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
