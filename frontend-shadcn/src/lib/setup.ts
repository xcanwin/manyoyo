import { apiGet, apiPost } from "@/lib/api"

export type SetupEnvEntry = { name: string; description: string; secret: boolean }
export type SetupAgent = {
  id: string
  label: string
  yolo: string
  modelKey: string
  requiredAnyOf: string[]
  baseUrlKey: string
  baseUrlPresets: { label: string; value: string }[]
  env: SetupEnvEntry[]
}
export type SetupStatus = {
  needsSetup: boolean
  configuredAgents: string[]
  configError: string | null
  runtime: { status: string; message: string }
  image: { status: "ready" | "missing" | "unknown" | "pulling" | "failed"; name: string; message?: string }
  defaultHostPath: string
  platform: string
  runtimeKind: string
  serverUser: string
  passwordSet: boolean
  mirrors?: { apt: string; npm: string; pip: string }
}
export type ConnectionCategory = "success" | "network" | "auth" | "other"
export type ConnectionResult = { category: ConnectionCategory; message: string; detail: string }

export type AccessMode = "official" | "compatible" | "subscription"
export type SetupForm = {
  agentId: string
  mode: AccessMode
  apiKey: string
  baseUrl: string
  model: string
  hostPath: string
}

export const AGENT_BLURBS: Record<string, string> = {
  claude: "Anthropic 出品，代码理解与长任务最稳",
  codex: "OpenAI 出品，命令行里直接改代码、跑命令",
  gemini: "Google 出品，上下文长，适合读大项目",
  opencode: "开源终端 Agent，可接各类兼容 OpenAI 的模型服务",
}

export type ReadinessItem = { key: "runtime" | "image"; label: string; state: "done" | "doing" | "waiting" | "failed" }
export type Readiness = { ready: boolean; percent: number; items: ReadinessItem[]; blockedReason: string }

// 运行时 + 镜像都就绪才算就绪；未就绪时给出“为什么置灰”的一句话
export function getReadiness(status: SetupStatus | null): Readiness {
  if (!status) {
    return {
      ready: false,
      percent: 0,
      items: [
        { key: "runtime", label: "容器环境", state: "waiting" },
        { key: "image", label: "运行镜像", state: "waiting" },
      ],
      blockedReason: "正在检查容器环境",
    }
  }
  const runtimeState: ReadinessItem["state"] =
    status.runtime.status === "ready" ? "done" : status.runtime.status === "failed" ? "failed" : "doing"
  const imageState: ReadinessItem["state"] =
    status.image.status === "ready"
      ? "done"
      : status.image.status === "failed"
        ? "failed"
        : runtimeState === "done"
          ? "doing"
          : "waiting"
  const items: ReadinessItem[] = [
    { key: "runtime", label: "容器环境", state: runtimeState },
    { key: "image", label: "运行镜像", state: imageState },
  ]
  const done = items.filter((item) => item.state === "done").length
  const ready = done === items.length
  let blockedReason = ""
  if (runtimeState === "failed") blockedReason = status.runtime.message || "容器环境启动失败"
  else if (runtimeState !== "done") blockedReason = status.runtime.message || "正在启动容器环境"
  else if (imageState === "failed") blockedReason = status.image.message || `运行镜像 ${status.image.name} 拉取失败`
  else if (imageState !== "done") {
    blockedReason = `正在准备运行镜像 ${status.image.name}${status.image.status === "pulling" && status.image.message ? `（${status.image.message}）` : ""}`
  }
  return { ready, percent: Math.round((done / items.length) * 100), items, blockedReason }
}

export function getModeKeyEnvName(agent: SetupAgent): string {
  return agent.requiredAnyOf[0]
}

export function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

// 返回空串表示通过；step 从 1 开始
export function validateStep(step: 1 | 2 | 3, form: SetupForm, agent: SetupAgent | null): string {
  if (step === 1) return agent ? "" : "请选择一个 Agent"
  if (step === 2) {
    if (form.mode === "subscription") return "订阅登录即将支持，请先选择其它接入方式"
    if (!form.apiKey.trim()) return "请填写 API Key"
    if (form.mode === "compatible") {
      if (!form.baseUrl.trim()) return "请填写兼容服务的 Base URL"
      if (!isValidBaseUrl(form.baseUrl)) return "Base URL 必须以 http:// 或 https:// 开头"
    }
    return ""
  }
  return form.hostPath.trim() ? "" : "请选择工作目录"
}

// 只包含要写入的变量；空值不发，服务端把空串当“不改动”
export function buildEnvBody(agent: SetupAgent, form: SetupForm): Record<string, string> {
  const env: Record<string, string> = {}
  const key = form.apiKey.trim()
  if (key) env[getModeKeyEnvName(agent)] = key
  if (form.mode === "compatible" && form.baseUrl.trim()) env[agent.baseUrlKey] = form.baseUrl.trim()
  if (form.model.trim()) env[agent.modelKey] = form.model.trim()
  return env
}

export function connectionNotice(result: ConnectionResult): { tone: "success" | "error"; text: string } {
  switch (result.category) {
    case "success":
      return { tone: "success", text: "连接成功，可以继续下一步" }
    case "network":
      return {
        tone: "error",
        text: "网络不可达：无法连接到 API 地址。在国内网络下请改用「兼容服务」并填写可访问的 Base URL，或检查代理设置。",
      }
    case "auth":
      return { tone: "error", text: "认证失败：Key 无效或没有权限，请检查后重新填写。" }
    default:
      return { tone: "error", text: result.message ? `测试失败：${result.message}` : "测试失败，请稍后重试。" }
  }
}

// Podman machine 默认只共享 /Users；其它位置会挂载失败
export function getDirectoryHint(path: string, status: SetupStatus | null): string {
  if (!status || !path) return ""
  if (status.platform === "darwin" && status.runtimeKind === "podman" && !path.startsWith("/Users/")) {
    return "该目录不在 Podman 默认共享范围（/Users）内，容器可能无法挂载；建议选择 /Users 下的目录。"
  }
  return ""
}

export const fetchSetupStatus = async () => (await apiGet("/api/setup/status")) as unknown as SetupStatus
export const fetchSetupAgents = async () =>
  ((await apiGet("/api/setup/agents")).agents ?? []) as unknown as SetupAgent[]
export const testConnection = async (agent: string, env: Record<string, string>) =>
  (await apiPost("/api/setup/test-connection", { agent, env })) as unknown as ConnectionResult
export const saveAgent = (agent: string, env: Record<string, string>, hostPath: string) =>
  apiPost("/api/setup/agent", { agent, env, hostPath })
export const createAgentSession = async (run: string) => String((await apiPost("/api/sessions", { run })).name)

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

// 返回空串表示通过
export function validatePassword(password: string, confirm: string): string {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(password)) return "密码不能包含换行、制表符等控制字符"
  if (password !== confirm) return "两次输入的密码不一致"
  return ""
}

export type PasswordStrength = { level: "weak" | "medium" | "strong"; label: string }

// 只是提示，不阻止提交：长度 + 字符种类的粗略打分
export function passwordStrength(password: string): PasswordStrength {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (password.length >= 12 && kinds >= 3) return { level: "strong", label: "强度：强" }
  if (password.length >= 8 && kinds >= 2) return { level: "medium", label: "强度：中，建议再长一些或混用字母、数字、符号" }
  return { level: "weak", label: "强度：弱，建议混用字母、数字、符号" }
}

export const savePassword = (password: string) => apiPost("/api/setup/password", { password })

// 容器环境/镜像失败后重新尝试（服务端只在失败态才会重启自愈或重拉镜像）
export function retrySetupRuntime(): Promise<unknown> {
  return apiPost("/api/system/runtime/retry")
}
