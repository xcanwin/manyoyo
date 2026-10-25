import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api"
import type { ConnectionResult, SetupProvider } from "@/lib/setup"

export type ModelService = {
  name: string
  agent: string
  agentLabel: string
  providerId: string
  providerLabel: string
  authMode: "key" | "subscription"
  baseUrl: string
  keyEnv: string
  // 只有末 4 位（…abcd），服务端从不下发 Key
  keyTail: string
  model: string
  quickChatDefault: boolean
  // 这家服务必需、但运行配置里还没有的附加变量（如智谱的 ENABLE_TOOL_SEARCH=false）
  missingExtraEnv?: Record<string, string>
  // 仅 Claude Code：档位 / 子 Agent 模型变量与自动压缩窗口
  models?: Record<string, string>
  autoCompactWindow?: string
}
export type ReuseSuggestion = {
  from: string
  agent: string
  providerId: string
  label: string
}
export type ModelServiceAgent = {
  id: string
  label: string
  providers: SetupProvider[]
}
export type ModelServicesData = {
  // 编辑时勾选“同时更新容器”后，实际被更新的容器名
  updatedContainers?: string[]
  services: ModelService[]
  suggestions: ReuseSuggestion[]
  agents: ModelServiceAgent[]
  name?: string
}

export type ServiceForm = {
  agent: string
  mode: "key" | "subscription"
  // "" = 自定义地址
  providerId: string
  baseUrl: string
  key: string
  model: string
  name: string
  // 仅 Claude Code 编辑：档位 / 子 Agent 模型，自动压缩窗口（原值）与开关
  models: Record<string, string>
  autoCompactWindow: string
  autoCompact1m: boolean
}

export const CLAUDE_MODEL_FIELDS: { key: string; label: string }[] = [
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "大模型（Opus）" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "中模型（Sonnet）" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "小模型（Haiku）" },
  { key: "ANTHROPIC_DEFAULT_FABLE_MODEL", label: "Fable 模型" },
  { key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "子 Agent 模型" },
]

export const EMPTY_CLAUDE_MODELS: Record<string, string> = Object.fromEntries(
  CLAUDE_MODEL_FIELDS.map((item) => [item.key, ""])
)

export const AUTO_COMPACT_1M = "1000000"

export const EMPTY_SERVICE_FORM: ServiceForm = {
  agent: "claude",
  mode: "key",
  providerId: "",
  baseUrl: "",
  key: "",
  model: "",
  name: "",
  models: EMPTY_CLAUDE_MODELS,
  autoCompactWindow: "",
  autoCompact1m: false,
}

export const fetchModelServices = () =>
  apiGet("/api/model-services") as unknown as Promise<ModelServicesData>
export const createModelService = (body: Record<string, unknown>) =>
  apiPost("/api/model-services", body) as unknown as Promise<ModelServicesData>
export const updateModelService = (
  name: string,
  body: Record<string, unknown>
) =>
  apiPut(
    `/api/model-services/${encodeURIComponent(name)}`,
    body
  ) as unknown as Promise<ModelServicesData>
export const fetchServiceContainers = (name: string) =>
  apiGet(
    `/api/model-services/${encodeURIComponent(name)}/containers`
  ) as unknown as Promise<{ containers: string[] }>
export const deleteModelService = (name: string) =>
  apiDelete(
    `/api/model-services/${encodeURIComponent(name)}`
  ) as unknown as Promise<ModelServicesData>
export const testModelService = (name: string) =>
  apiPost(
    `/api/model-services/${encodeURIComponent(name)}/test`
  ) as unknown as Promise<ConnectionResult>

// 列表里一行的标题：Claude Code CLI · 智谱 GLM
export function serviceTitle(
  service: Pick<ModelService, "agentLabel" | "providerLabel">
): string {
  return `${service.agentLabel} · ${service.providerLabel}`
}

// 返回空串表示通过
export function validateServiceForm(
  form: ServiceForm,
  mode: "create" | "edit"
): string {
  if (form.mode === "subscription") {
    if (form.agent !== "claude")
      return "Codex CLI 的订阅登录在容器终端里完成，这里不用保存"
    return form.key.trim() ? "" : "请粘贴订阅令牌"
  }
  if (mode === "create" && !form.key.trim()) return "请填写 API Key"
  if (!form.providerId) {
    if (mode === "create" && !form.baseUrl.trim())
      return "请选择服务商，或填写自定义 Base URL"
    if (form.baseUrl.trim() && !/^https?:\/\//i.test(form.baseUrl.trim()))
      return "Base URL 必须以 http:// 或 https:// 开头"
  }
  if (
    mode === "create" &&
    form.agent === "codex" &&
    !form.providerId &&
    !form.model.trim()
  )
    return "Codex CLI 接兼容服务必须填写模型名"
  return ""
}

// 新增请求体：选了服务商就由服务端按预设填地址、模型和附加变量
export function buildCreateBody(form: ServiceForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent: form.agent,
    key: form.key.trim(),
  }
  if (form.name.trim()) body.name = form.name.trim()
  if (form.model.trim()) body.model = form.model.trim()
  if (form.mode === "subscription") body.subscription = true
  else if (form.providerId) body.providerId = form.providerId
  else body.baseUrl = form.baseUrl.trim()
  return body
}

// 编辑请求体：Key 留空表示不改
export function buildEditBody(
  form: ServiceForm,
  syncContainers = false
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: form.model.trim() }
  if (syncContainers) body.syncContainers = true
  if (form.key.trim()) body.key = form.key.trim()
  if (form.mode === "subscription") body.subscription = true
  else body.baseUrl = form.baseUrl.trim()
  if (form.agent === "claude") {
    body.models = Object.fromEntries(
      Object.entries(form.models).map(([key, value]) => [key, value.trim()])
    )
    if (form.autoCompact1m !== (form.autoCompactWindow === AUTO_COMPACT_1M)) {
      body.autoCompact1m = form.autoCompact1m
    }
  }
  return body
}

export function resultTone(result: ConnectionResult): "success" | "error" {
  return result.category === "success" ? "success" : "error"
}

// 运行配置下拉里的显示名：Claude Code · 智谱 GLM（claude-glm）；不是模型服务的运行配置仍显示原名
export function runLabelMap(
  services: Pick<ModelService, "name" | "agentLabel" | "providerLabel">[]
): Record<string, string> {
  return Object.fromEntries(
    services.map((item) => [item.name, `${serviceTitle(item)}（${item.name}）`])
  )
}

export const runLabel = (name: string, labels: Record<string, string>) =>
  labels[name] ?? name

export type ImportCandidate = {
  id: string
  agent: string
  agentLabel: string
  providerLabel: string
  baseUrl: string
  model: string
  keyTail: string
  duplicate: boolean
  invalid: string
}
export type ImportPreview = {
  candidates: ImportCandidate[]
  sources: { agent: string; label: string; where: string }[]
}

export const fetchImportPreview = () =>
  apiGet(
    "/api/model-services/import-preview"
  ) as unknown as Promise<ImportPreview>
export const importLocalServices = (ids: string[]) =>
  apiPost("/api/model-services/import", { ids }) as unknown as Promise<
    ModelServicesData & { names: string[] }
  >
