import { apiGet, apiPost } from "@/lib/api"
import { formatTimestampCompact } from "@/lib/format"

export type SetupEnvEntry = { name: string; description: string; secret: boolean }
export type SetupProvider = {
  id: string
  label: string
  docUrl: string
  baseUrl: string
  keyEnv: string
  models: string[]
  defaultModel: string
  // 这家服务必须附带的变量（如智谱的 ENABLE_TOOL_SEARCH=false），选中服务商时一起写入
  extraEnv?: Record<string, string>
}
export type SetupAgent = {
  id: string
  label: string
  yolo: string
  modelKey: string
  requiredAnyOf: string[]
  baseUrlKey: string
  baseUrlPresets: { label: string; value: string }[]
  // 兼容服务的服务商预设（网页向导和命令行向导共用服务端的同一份数据）
  providers?: SetupProvider[]
  env: SetupEnvEntry[]
  // 镜像里有没有这个 CLI：null = 还不知道（镜像没就绪），照常可选
  available?: boolean | null
}
export type SetupStatus = {
  needsSetup: boolean
  setupSkipped?: boolean
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
export type ConnectionCategory = "success" | "no_tools" | "quota" | "model" | "network" | "auth" | "missing_cli" | "other"
export type ConnectionResult = { category: ConnectionCategory; message: string; detail: string }

export type AccessMode = "official" | "compatible" | "subscription"
export type SetupForm = {
  agentId: string
  mode: AccessMode
  apiKey: string
  baseUrl: string
  model: string
  hostPath: string
  // 选了服务商预设后，Key 要写进哪个变量（空 = 该 Agent 的默认变量）
  keyEnv?: string
  // 选中的服务商预设 id，用来显示“官方说明”和模型占位
  providerId?: string
  extraEnv?: Record<string, string>
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

// 订阅登录用长期令牌（Claude 的 claude setup-token）；Codex 的订阅登录在容器终端里完成，不经过这里
export const SUBSCRIPTION_KEY_ENV = "CLAUDE_CODE_OAUTH_TOKEN"

export function getModeKeyEnvName(agent: SetupAgent, mode: AccessMode = "official"): string {
  if (mode === "subscription") return SUBSCRIPTION_KEY_ENV
  return agent.requiredAnyOf[0]
}

// Base URL 输入框的占位：Claude 的兼容地址以 /anthropic 结尾，不是 /v1
export function baseUrlPlaceholder(agent: SetupAgent): string {
  return agent.id === "claude" ? "例如 https://…/anthropic" : "例如 https://your-service.example.com/v1"
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
    if (form.mode === "subscription") {
      if (agent?.id !== "claude") return "Codex CLI 的订阅登录要进容器终端运行 codex login --device-auth，向导里请先选其它接入方式"
      if (form.baseUrl.trim() && !isValidBaseUrl(form.baseUrl)) return "Base URL 必须以 http:// 或 https:// 开头"
      return form.apiKey.trim() ? "" : "请粘贴订阅令牌"
    }
    if (!form.apiKey.trim()) return "请填写 API Key"
    if (form.mode === "compatible") {
      if (!form.baseUrl.trim()) return "请填写兼容服务的 Base URL"
      if (!isValidBaseUrl(form.baseUrl)) return "Base URL 必须以 http:// 或 https:// 开头"
      if (agent?.id === "codex" && !form.model.trim()) return "Codex CLI 接兼容服务必须填写模型名"
    }
    return ""
  }
  return form.hostPath.trim() ? "" : "请选择工作目录"
}

// 只包含要写入的变量；空值不发，服务端把空串当“不改动”
export function buildEnvBody(agent: SetupAgent, form: SetupForm): Record<string, string> {
  const env: Record<string, string> = {}
  const key = form.apiKey.trim()
  if (key) env[form.mode === "compatible" && form.keyEnv ? form.keyEnv : getModeKeyEnvName(agent, form.mode)] = key
  if ((form.mode === "compatible" || form.mode === "subscription") && form.baseUrl.trim()) env[agent.baseUrlKey] = form.baseUrl.trim()
  if (form.mode === "compatible") Object.assign(env, form.extraEnv ?? {})
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
      return { tone: "error", text: result.message || "测试失败，请稍后重试。" }
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

export const AGENT_UNAVAILABLE_HINT = "当前镜像未安装，需要 full 镜像"
export const isAgentUnavailable = (agent: { available?: boolean | null }) => agent.available === false

export const fetchSetupStatus = async () => (await apiGet("/api/setup/status")) as unknown as SetupStatus
export const fetchSetupAgents = async () =>
  ((await apiGet("/api/setup/agents")).agents ?? []) as unknown as SetupAgent[]
export const testConnection = async (agent: string, env: Record<string, string>) =>
  (await apiPost("/api/setup/test-connection", { agent, env })) as unknown as ConnectionResult
export const saveAgent = (agent: string, env: Record<string, string>, hostPath: string) =>
  apiPost("/api/setup/agent", { agent, env, hostPath })
// 与快捷对话一致：在工作目录下建一个带时间戳的子目录，宿主机路径和容器内路径相同。
// 不传 containerPath 时服务端会退回它自己的启动目录（安装时通常是用户主目录），首个容器就会挂到 $HOME。
// 跳过向导要落盘，否则刷新后又弹
export const skipSetup = () => apiPost("/api/setup/skip", {})

export async function createAgentSession(run: string, workPath: string): Promise<string> {
  const requestedDir = `${workPath.replace(/\/+$/, "")}/${formatTimestampCompact(new Date())}`
  const made = await apiPost("/api/fs/directories/mkdir", { path: requestedDir })
  const dir = typeof made.path === "string" && made.path ? made.path : requestedDir
  return String((await apiPost("/api/sessions", { run, createOptions: { hostPath: dir, containerPath: dir } })).name)
}

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
