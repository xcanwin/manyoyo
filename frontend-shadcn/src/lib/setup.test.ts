import { describe, expect, test } from "vitest"

import {
  buildEnvBody,
  connectionNotice,
  getDirectoryHint,
  getReadiness,
  isValidBaseUrl,
  passwordStrength,
  validatePassword,
  validateStep,
  type SetupAgent,
  type SetupForm,
  type SetupStatus,
} from "@/lib/setup"

const claude: SetupAgent = {
  id: "claude",
  label: "Claude Code",
  yolo: "c",
  modelKey: "ANTHROPIC_MODEL",
  requiredAnyOf: ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  baseUrlKey: "ANTHROPIC_BASE_URL",
  baseUrlPresets: [{ label: "官方", value: "https://api.anthropic.com" }],
  env: [],
}

const form = (over: Partial<SetupForm> = {}): SetupForm => ({
  agentId: "claude",
  mode: "official",
  apiKey: "",
  baseUrl: "",
  model: "",
  hostPath: "",
  ...over,
})

const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  needsSetup: true,
  configuredAgents: [],
  configError: null,
  runtime: { status: "ready", message: "" },
  image: { status: "ready", name: "img:1" },
  defaultHostPath: "/Users/me/.manyoyo/work",
  platform: "linux",
  runtimeKind: "docker",
  serverUser: "admin",
  passwordSet: true,
  ...over,
})

describe("getReadiness", () => {
  test("unknown status is blocked", () => {
    const r = getReadiness(null)
    expect(r.ready).toBe(false)
    expect(r.percent).toBe(0)
    expect(r.blockedReason).toContain("检查")
  })

  test("runtime starting blocks and explains why", () => {
    const r = getReadiness(status({ runtime: { status: "starting", message: "正在启动容器环境" }, image: { status: "unknown", name: "img:1" } }))
    expect(r.ready).toBe(false)
    expect(r.items.map((i) => i.state)).toEqual(["doing", "waiting"])
    expect(r.blockedReason).toBe("正在启动容器环境")
  })

  test("image missing while runtime is ready is 'doing' at 50%", () => {
    const r = getReadiness(status({ image: { status: "missing", name: "img:1" } }))
    expect(r.items.map((i) => i.state)).toEqual(["done", "doing"])
    expect(r.percent).toBe(50)
    expect(r.blockedReason).toContain("img:1")
  })

  test("an image being pulled shows its progress line; a failed pull shows the reason", () => {
    const pulling = getReadiness(status({ image: { status: "pulling", name: "img:1", message: "Copying blob 3/5" } }))
    expect(pulling.items[1].state).toBe("doing")
    expect(pulling.blockedReason).toContain("Copying blob 3/5")
    const failed = getReadiness(status({ image: { status: "failed", name: "img:1", message: "镜像 img:1 不存在" } }))
    expect(failed.items[1].state).toBe("failed")
    expect(failed.ready).toBe(false)
    expect(failed.blockedReason).toBe("镜像 img:1 不存在")
  })

  test("runtime failure surfaces its message", () => {
    const r = getReadiness(status({ runtime: { status: "failed", message: "podman machine start 失败" }, image: { status: "unknown", name: "img:1" } }))
    expect(r.items[0].state).toBe("failed")
    expect(r.blockedReason).toBe("podman machine start 失败")
  })

  test("everything ready", () => {
    const r = getReadiness(status())
    expect(r).toEqual(expect.objectContaining({ ready: true, percent: 100, blockedReason: "" }))
  })
})

describe("validateStep", () => {
  test("step 1 needs an agent", () => {
    expect(validateStep(1, form(), null)).toMatch(/选择/)
    expect(validateStep(1, form(), claude)).toBe("")
  })

  test("step 2 validates key, mode and base url", () => {
    expect(validateStep(2, form(), claude)).toMatch(/API Key/)
    expect(validateStep(2, form({ apiKey: "k" }), claude)).toBe("")
    expect(validateStep(2, form({ mode: "subscription", apiKey: "k" }), claude)).toMatch(/即将支持/)
    expect(validateStep(2, form({ mode: "compatible", apiKey: "k" }), claude)).toMatch(/Base URL/)
    expect(validateStep(2, form({ mode: "compatible", apiKey: "k", baseUrl: "ftp://x" }), claude)).toMatch(/http/)
    expect(validateStep(2, form({ mode: "compatible", apiKey: "k", baseUrl: "https://x.example/v1" }), claude)).toBe("")
  })

  test("step 3 needs a directory", () => {
    expect(validateStep(3, form(), claude)).toMatch(/目录/)
    expect(validateStep(3, form({ hostPath: "/w" }), claude)).toBe("")
  })

  test("base url check", () => {
    expect(isValidBaseUrl("https://a.b")).toBe(true)
    expect(isValidBaseUrl("a.b")).toBe(false)
  })
})

describe("buildEnvBody", () => {
  test("official mode sends only key (and model when set)", () => {
    expect(buildEnvBody(claude, form({ apiKey: " k " }))).toEqual({ ANTHROPIC_AUTH_TOKEN: "k" })
    expect(buildEnvBody(claude, form({ apiKey: "k", model: "m", baseUrl: "https://ignored" }))).toEqual({
      ANTHROPIC_AUTH_TOKEN: "k",
      ANTHROPIC_MODEL: "m",
    })
  })

  test("compatible mode adds the base url", () => {
    expect(buildEnvBody(claude, form({ mode: "compatible", apiKey: "k", baseUrl: " https://x/v1 " }))).toEqual({
      ANTHROPIC_AUTH_TOKEN: "k",
      ANTHROPIC_BASE_URL: "https://x/v1",
    })
  })
})

describe("connectionNotice", () => {
  test("covers the four outcomes", () => {
    expect(connectionNotice({ category: "success", message: "", detail: "" }).tone).toBe("success")
    const network = connectionNotice({ category: "network", message: "", detail: "" })
    expect(network.tone).toBe("error")
    expect(network.text).toContain("Base URL")
    expect(network.text).toContain("国内")
    expect(connectionNotice({ category: "auth", message: "", detail: "" }).text).toContain("认证失败")
    expect(connectionNotice({ category: "other", message: "镜像尚未就绪", detail: "" }).text).toContain("镜像尚未就绪")
    expect(connectionNotice({ category: "other", message: "", detail: "" }).text).toContain("测试失败")
  })
})

describe("getDirectoryHint", () => {
  test("only warns on macOS podman outside /Users", () => {
    const mac = status({ platform: "darwin", runtimeKind: "podman" })
    expect(getDirectoryHint("/Volumes/data", mac)).toContain("/Users")
    expect(getDirectoryHint("/Users/me/code", mac)).toBe("")
    expect(getDirectoryHint("/Volumes/data", status({ platform: "darwin", runtimeKind: "docker" }))).toBe("")
    expect(getDirectoryHint("/srv", status())).toBe("")
    expect(getDirectoryHint("", mac)).toBe("")
    expect(getDirectoryHint("/x", null)).toBe("")
  })
})

describe("validatePassword / passwordStrength", () => {
  test("validates length, control characters and confirmation", () => {
    expect(validatePassword("short", "short")).toContain("至少 8 位")
    expect(validatePassword("a".repeat(129), "a".repeat(129))).toContain("不能超过")
    expect(validatePassword("abcdefg\n1", "abcdefg\n1")).toContain("控制字符")
    expect(validatePassword("abcdefgh1", "abcdefgh2")).toContain("不一致")
    expect(validatePassword("abcdefgh1", "abcdefgh1")).toBe("")
  })

  test("strength is only a hint: weak, medium, strong", () => {
    expect(passwordStrength("aaaaaaaa").level).toBe("weak")
    expect(passwordStrength("abc12345").level).toBe("medium")
    expect(passwordStrength("Abc123!xyz789").level).toBe("strong")
  })
})
