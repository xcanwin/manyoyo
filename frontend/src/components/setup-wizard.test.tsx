import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SetupWizard } from "@/components/setup-wizard"
import * as setupApi from "@/lib/setup"
import * as doctorApi from "@/lib/doctor"
import * as mirrorApi from "@/lib/mirrors"
import type { SetupAgent, SetupStatus } from "@/lib/setup"

vi.mock("@/lib/setup", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/setup")>()
  return {
    ...original,
    fetchSetupAgents: vi.fn(),
    fetchSetupStatus: vi.fn(),
    testConnection: vi.fn(),
    saveAgent: vi.fn(),
    savePassword: vi.fn(),
    retrySetupRuntime: vi.fn(),
    createAgentSession: vi.fn(),
  }
})

vi.mock("@/lib/mirrors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mirrors")>()),
  fetchMirrorPresets: vi.fn(async () => ({
    apt: [{ label: "阿里云", value: "https://mirrors.aliyun.com" }],
    npm: [{ label: "阿里云", value: "https://registry.npmmirror.com/" }],
    pip: [{ label: "清华", value: "https://pypi.tuna.tsinghua.edu.cn/simple" }],
  })),
  saveMirrors: vi.fn(),
}))

vi.mock("@/lib/doctor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/doctor")>()),
  fetchDoctor: vi.fn(),
  runDoctorFix: vi.fn(),
}))

// 组件里用到的 DirectoryPickerDialog 只在打开时才发请求，这里不会触发
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: SetupAgent[] = [
  {
    id: "claude",
    label: "Claude Code",
    yolo: "c",
    modelKey: "ANTHROPIC_MODEL",
    requiredAnyOf: ["ANTHROPIC_AUTH_TOKEN"],
    baseUrlKey: "ANTHROPIC_BASE_URL",
    baseUrlPresets: [{ label: "Anthropic 官方", value: "https://api.anthropic.com" }],
    providers: [
      { id: "deepseek", label: "DeepSeek", docUrl: "https://docs.example/ds", baseUrl: "https://api.deepseek.com/anthropic", keyEnv: "ANTHROPIC_AUTH_TOKEN", models: ["deepseek-flash[1m]"], defaultModel: "deepseek-flash[1m]" },
      { id: "kimicode", label: "Kimi Code", docUrl: "https://docs.example/kc", baseUrl: "https://api.kimi.ai/coding/", keyEnv: "ANTHROPIC_API_KEY", models: [], defaultModel: "" },
    ],
    env: [],
  },
  {
    id: "codex",
    label: "Codex",
    yolo: "cx",
    modelKey: "OPENAI_MODEL",
    requiredAnyOf: ["OPENAI_API_KEY"],
    baseUrlKey: "OPENAI_BASE_URL",
    baseUrlPresets: [],
    env: [],
  },
]

const readyStatus: SetupStatus = {
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
}

const startingStatus: SetupStatus = {
  ...readyStatus,
  runtime: { status: "starting", message: "正在启动容器环境" },
  image: { status: "unknown", name: "img:1" },
}

let container: HTMLDivElement
let root: Root
const api = vi.mocked(setupApi)

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(status: SetupStatus, props: Partial<React.ComponentProps<typeof SetupWizard>> = {}) {
  api.fetchSetupAgents.mockResolvedValue(agents)
  api.fetchSetupStatus.mockResolvedValue(status)
  const onFinished = props.onFinished ?? vi.fn()
  const onSkip = props.onSkip ?? vi.fn()
  await act(async () => {
    root.render(<SetupWizard onFinished={onFinished} onSkip={onSkip} />)
  })
  await flush()
  return { onFinished, onSkip }
}

const text = () => container.textContent ?? ""
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(label)) as HTMLButtonElement
const radio = (label: string) =>
  Array.from(container.querySelectorAll('[role="radio"]')).find((b) => (b.textContent ?? "").includes(label)) as HTMLElement

// 服务商是下拉：点开触发器，再点选项
async function pickProvider(label: string) {
  const trigger = container.querySelector('[aria-label="服务商"]') as HTMLElement
  await act(async () => trigger.click())
  await flush()
  const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) => el.textContent?.trim() === label) as HTMLElement
  await act(async () => option.click())
  await flush()
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("element not found")
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flush()
}

async function type(id: string, value: string) {
  const input = container.querySelector(`#${id}`) as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("SetupWizard", () => {
  test("starts on step 1 with the agents from the server and requires a choice", async () => {
    await mount(readyStatus)
    expect(text()).toContain("第 1 / 4 步")
    expect(text()).toContain("Claude Code")
    expect(text()).toContain("Codex")

    await click(button("下一步"))
    expect(text()).toContain("请选择一个 Agent")
    expect(text()).toContain("第 1 / 4 步")
  })

  test("step 2 validates key and compatible base url", async () => {
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    expect(text()).toContain("第 2 / 4 步")

    await click(button("下一步"))
    expect(text()).toContain("请填写 API Key")

    await click(radio("兼容服务"))
    await type("setup-api-key", "sk-x")
    await click(button("下一步"))
    expect(text()).toContain("请填写兼容服务的 Base URL")

    await click(button("Anthropic 官方"))
    await click(button("下一步"))
    expect(text()).toContain("第 3 / 4 步")
  })

  test("subscription login: Claude pastes a long-lived token; Codex is pointed to the container terminal", async () => {
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await click(radio("订阅登录"))
    expect(text()).toContain("claude setup-token")
    expect(text()).toContain("订阅令牌")
    await click(button("下一步"))
    expect(text()).toContain("请粘贴订阅令牌")
    await type("setup-api-key", "oauth-token-123456")
    await click(button("下一步"))
    expect(text()).toContain("第 3 / 4 步")
  })

  test("before the environment is ready, testing and saving are disabled with the reason shown", async () => {
    await mount(startingStatus)
    expect(text()).toContain("容器环境：准备中")
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-x")
    expect(button("测试连接").disabled).toBe(true)
    expect(text()).toContain("正在启动容器环境，就绪后可测试连接")

    await click(button("下一步"))
    await click(button("下一步"))
    expect(text()).toContain("第 4 / 4 步")
    expect(button("保存并进入").disabled).toBe(true)
    expect(text()).toContain("就绪后可保存并进入")
    expect(api.saveAgent).not.toHaveBeenCalled()
  })

  test.each([
    ["success", "连接成功"],
    ["network", "国内"],
    ["auth", "认证失败"],
    ["other", "镜像尚未就绪"],
  ] as const)("test connection result %s shows the matching hint", async (category, expected) => {
    api.testConnection.mockResolvedValue({ category, message: "镜像尚未就绪", detail: "" })
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await click(button("测试连接"))

    expect(api.testConnection).toHaveBeenCalledWith("claude", { ANTHROPIC_AUTH_TOKEN: "sk-secret" })
    expect(text()).toContain(expected)
    // 成功是绿色，失败走 destructive（红），二者不能混
    const alert = container.querySelector('[data-slot="alert"][data-tone]') as HTMLElement
    expect(alert.dataset.tone).toBe(category === "success" ? "success" : "error")
    expect(alert.className.includes("text-success")).toBe(category === "success")
    expect(text()).not.toContain("sk-secret")
  })

  test("失败时消息不重复前缀，详情可展开", async () => {
    api.testConnection.mockResolvedValue({ category: "other", message: "测试失败，请查看详情", detail: "boom: something broke" })
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await click(button("测试连接"))
    expect(text()).not.toContain("测试失败：测试失败")
    const details = container.querySelector("details") as HTMLElement
    expect(details.textContent).toContain("详情")
    expect(details.textContent).toContain("boom: something broke")
  })

  test("镜像里没装的 Agent 置灰且不能选", async () => {
    api.fetchSetupStatus.mockResolvedValue(readyStatus)
    api.fetchSetupAgents.mockResolvedValue([agents[0], { ...agents[1], available: false }])
    await act(async () => {
      root.render(<SetupWizard onFinished={vi.fn()} onSkip={vi.fn()} />)
    })
    await flush()
    const codex = radio("Codex") as HTMLButtonElement
    expect(codex.disabled).toBe(true)
    expect(codex.textContent).toContain("当前镜像未安装，需要 full 镜像")
    await click(codex)
    await click(button("下一步"))
    expect(text()).toContain("请选择一个 Agent")
  })

  test("镜像就绪后重新取一次列表，已选中的 Agent 变成不可用时清空选择", async () => {
    api.fetchSetupAgents.mockResolvedValue(agents)
    api.fetchSetupStatus.mockResolvedValue(startingStatus)
    await act(async () => {
      root.render(<SetupWizard onFinished={vi.fn()} onSkip={vi.fn()} />)
    })
    await flush()
    await click(radio("Codex"))
    expect(radio("Codex").getAttribute("aria-checked")).toBe("true")
    api.fetchSetupAgents.mockResolvedValue([agents[0], { ...agents[1], available: false }])
    api.fetchSetupStatus.mockResolvedValue(readyStatus)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300))
    })
    await flush()
    expect(api.fetchSetupAgents.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(radio("Codex").getAttribute("aria-checked")).toBe("false")
  })

  test("兼容服务：点服务商预设填好 Base URL、Key 变量和必填模型，并给出官方说明；Claude 的占位不是 /v1", async () => {
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await click(radio("兼容服务"))
    expect((container.querySelector("#setup-base-url") as HTMLInputElement).placeholder).toContain("/anthropic")
    await pickProvider("DeepSeek")
    expect((container.querySelector("#setup-base-url") as HTMLInputElement).value).toBe("https://api.deepseek.com/anthropic")
    expect((container.querySelector("#setup-model") as HTMLInputElement).value).toBe("deepseek-flash[1m]")
    expect(container.querySelector('a[href="https://docs.example/ds"]')?.textContent).toBe("官方说明")
    await type("setup-api-key", "sk-secret")
    api.testConnection.mockResolvedValue({ category: "success", message: "", detail: "" })
    await click(button("测试连接"))
    expect(api.testConnection).toHaveBeenCalledWith("claude", {
      ANTHROPIC_AUTH_TOKEN: "sk-secret",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-flash[1m]",
    })
  })

  test("兼容服务：服务商要求 ANTHROPIC_API_KEY 时 Key 写进该变量；手改地址后恢复默认变量", async () => {
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await click(radio("兼容服务"))
    await pickProvider("Kimi Code")
    await type("setup-api-key", "k-1")
    api.testConnection.mockResolvedValue({ category: "success", message: "", detail: "" })
    await click(button("测试连接"))
    expect(api.testConnection).toHaveBeenLastCalledWith("claude", { ANTHROPIC_API_KEY: "k-1", ANTHROPIC_BASE_URL: "https://api.kimi.ai/coding/" })
    await type("setup-base-url", "https://my.example.com/anthropic")
    await click(button("测试连接"))
    expect(api.testConnection).toHaveBeenLastCalledWith("claude", { ANTHROPIC_AUTH_TOKEN: "k-1", ANTHROPIC_BASE_URL: "https://my.example.com/anthropic" })
  })

  test("the key input is a password field", async () => {
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    expect((container.querySelector("#setup-api-key") as HTMLInputElement).type).toBe("password")
  })

  test("saving sends env + directory, creates the session and hands over the container name", async () => {
    api.saveAgent.mockResolvedValue({})
    api.createAgentSession.mockResolvedValue("my-claude-0101-0000")
    const { onFinished } = await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await type("setup-model", "claude-x")
    await click(button("下一步"))
    expect(text()).toContain("第 3 / 4 步")
    expect((container.querySelector("#setup-host-path") as HTMLInputElement).value).toBe("/Users/me/.manyoyo/work")
    await click(button("下一步"))
    await click(button("保存并进入"))

    expect(api.saveAgent).toHaveBeenCalledWith(
      "claude",
      { ANTHROPIC_AUTH_TOKEN: "sk-secret", ANTHROPIC_MODEL: "claude-x" },
      "/Users/me/.manyoyo/work"
    )
    expect(api.createAgentSession).toHaveBeenCalledWith("claude", expect.any(String))
    expect(onFinished).toHaveBeenCalledWith("my-claude-0101-0000")
  })

  test("software sources are optional: untouched means nothing is saved", async () => {
    api.saveAgent.mockResolvedValue({})
    api.createAgentSession.mockResolvedValue("c")
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await type("setup-model", "m")
    await click(button("下一步"))
    expect(text()).toContain("软件源（可选）")
    expect(container.querySelector("#setup-mirror-npm")).toBeNull()
    await click(button("下一步"))
    await click(button("保存并进入"))
    expect(vi.mocked(mirrorApi).saveMirrors).not.toHaveBeenCalled()
  })

  test("a chosen software source is saved before the agent; an invalid custom one blocks saving", async () => {
    api.saveAgent.mockResolvedValue({})
    api.createAgentSession.mockResolvedValue("c")
    await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await type("setup-model", "m")
    await click(button("下一步"))
    await click(button("软件源（可选）"))
    const npm = container.querySelector("#setup-mirror-npm") as HTMLSelectElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(npm, "__custom__")
      npm.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await type("setup-mirror-npm-custom", "not-a-url")
    await click(button("下一步"))
    await click(button("保存并进入"))
    expect(text()).toContain("npm")
    expect(vi.mocked(mirrorApi).saveMirrors).not.toHaveBeenCalled()
    expect(api.saveAgent).not.toHaveBeenCalled()

    await click(button("上一步"))
    await type("setup-mirror-npm-custom", "https://my.corp/npm/")
    await click(button("下一步"))
    await click(button("保存并进入"))
    expect(vi.mocked(mirrorApi).saveMirrors).toHaveBeenCalledWith({ apt: "", npm: "https://my.corp/npm/", pip: "" })
    expect(api.saveAgent).toHaveBeenCalled()
  })

  test("a failed save shows the server error and does not finish", async () => {
    api.saveAgent.mockRejectedValue(new Error("env value 含非法字符: ANTHROPIC_AUTH_TOKEN"))
    const { onFinished } = await mount(readyStatus)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "bad")
    await click(button("下一步"))
    await click(button("下一步"))
    await click(button("保存并进入"))
    expect(text()).toContain("env value 含非法字符")
    expect(onFinished).not.toHaveBeenCalled()
    expect(button("保存并进入").disabled).toBe(false)
  })

  test("podman outside /Users gets a sharing hint on step 3", async () => {
    await mount({ ...readyStatus, platform: "darwin", runtimeKind: "podman", defaultHostPath: "/Volumes/data/work" })
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "k")
    await click(button("下一步"))
    expect(text()).toContain("Podman 默认共享范围")
  })

  test("skip and back navigation work", async () => {
    const { onSkip } = await mount(readyStatus)
    await click(radio("Codex"))
    await click(button("下一步"))
    expect(text()).toContain("第 2 / 4 步")
    await click(button("上一步"))
    expect(text()).toContain("第 1 / 4 步")
    await click(button("跳过向导"))
    expect(onSkip).toHaveBeenCalled()
  })

  async function toStep4(status: SetupStatus) {
    api.saveAgent.mockResolvedValue({})
    api.savePassword.mockResolvedValue({})
    api.createAgentSession.mockResolvedValue("my-claude-0101-0000")
    const handlers = await mount(status)
    await click(radio("Claude Code"))
    await click(button("下一步"))
    await type("setup-api-key", "sk-secret")
    await click(button("下一步"))
    await click(button("下一步"))
    return handlers
  }

  test("no password fields when a password is already set", async () => {
    await toStep4(readyStatus)
    expect(container.querySelector("#setup-password")).toBeNull()
  })

  test("asks for a password before saving, validates it and shows strength and the username", async () => {
    const { onFinished } = await toStep4({ ...readyStatus, passwordSet: false, serverUser: "webadmin" })
    expect(text()).toContain("登录密码")
    expect(text()).toContain("用户名是 webadmin")
    expect((container.querySelector("#setup-password") as HTMLInputElement).type).toBe("password")

    await click(button("保存并进入"))
    expect(text()).toContain("密码至少 8 位")
    expect(api.savePassword).not.toHaveBeenCalled()
    expect(api.saveAgent).not.toHaveBeenCalled()

    await type("setup-password", "abc12345")
    expect(container.querySelector('[data-testid="password-strength"]')?.textContent).toContain("中")
    await type("setup-password-confirm", "abc12346")
    await click(button("保存并进入"))
    expect(text()).toContain("两次输入的密码不一致")
    expect(api.savePassword).not.toHaveBeenCalled()

    await type("setup-password-confirm", "abc12345")
    await click(button("保存并进入"))
    expect(api.savePassword).toHaveBeenCalledWith("abc12345")
    expect(api.saveAgent).toHaveBeenCalled()
    expect(onFinished).toHaveBeenCalledWith("my-claude-0101-0000")
    expect(text()).not.toContain("abc12345")
  })

  test("a failed password save stops before saving the agent", async () => {
    await toStep4({ ...readyStatus, passwordSet: false })
    api.savePassword.mockRejectedValue(new Error("配置写入失败"))
    await type("setup-password", "abc12345")
    await type("setup-password-confirm", "abc12345")
    await click(button("保存并进入"))
    expect(text()).toContain("配置写入失败")
    expect(api.saveAgent).not.toHaveBeenCalled()
  })

  test("a failed runtime offers the environment check", async () => {
    const doctor = vi.mocked(doctorApi)
    doctor.fetchDoctor.mockResolvedValue({
      ok: false,
      checks: [{ code: "DAEMON_UNAVAILABLE", status: "error", summary: "podman daemon 不可用", action: "启动 podman daemon 后重试。", detail: "" }],
    })
    await mount({ ...readyStatus, runtime: { status: "failed", message: "虚拟机启动失败" } })
    expect(container.querySelector('[data-testid="doctor-panel"]')).toBeNull()
    await click(button("检查环境"))
    await flush()
    expect(text()).toContain("podman daemon 不可用")
    expect(text()).toContain("下一步：启动 podman daemon 后重试。")
  })

  test("a failed runtime can be retried", async () => {
    api.retrySetupRuntime.mockResolvedValue({})
    await mount({ ...readyStatus, runtime: { status: "failed", message: "虚拟机启动失败" } })
    await click(button("重试"))
    expect(api.retrySetupRuntime).toHaveBeenCalledTimes(1)
  })
})
