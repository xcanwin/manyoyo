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
}
export type ReuseSuggestion = { from: string; agent: string; providerId: string; label: string }
export type ModelServiceAgent = { id: string; label: string; providers: SetupProvider[] }
export type ModelServicesData = {
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
}

export const EMPTY_SERVICE_FORM: ServiceForm = { agent: "claude", mode: "key", providerId: "", baseUrl: "", key: "", model: "", name: "" }

export const fetchModelServices = () => apiGet("/api/model-services") as unknown as Promise<ModelServicesData>
export const createModelService = (body: Record<string, unknown>) =>
  apiPost("/api/model-services", body) as unknown as Promise<ModelServicesData>
export const updateModelService = (name: string, body: Record<string, unknown>) =>
  apiPut(`/api/model-services/${encodeURIComponent(name)}`, body) as unknown as Promise<ModelServicesData>
export const deleteModelService = (name: string) =>
  apiDelete(`/api/model-services/${encodeURIComponent(name)}`) as unknown as Promise<ModelServicesData>
export const testModelService = (name: string) =>
  apiPost(`/api/model-services/${encodeURIComponent(name)}/test`) as unknown as Promise<ConnectionResult>

// 列表里一行的标题：Claude Code · 智谱 GLM
export function serviceTitle(service: Pick<ModelService, "agentLabel" | "providerLabel">): string {
  return `${service.agentLabel} · ${service.providerLabel}`
}

// 返回空串表示通过
export function validateServiceForm(form: ServiceForm, mode: "create" | "edit"): string {
  if (form.mode === "subscription") {
    if (form.agent !== "claude") return "Codex 的订阅登录在容器终端里完成，这里不用保存"
    return form.key.trim() ? "" : "请粘贴订阅令牌"
  }
  if (mode === "create" && !form.key.trim()) return "请填写 API Key"
  if (!form.providerId) {
    if (mode === "create" && !form.baseUrl.trim()) return "请选择服务商，或填写自定义 Base URL"
    if (form.baseUrl.trim() && !/^https?:\/\//i.test(form.baseUrl.trim())) return "Base URL 必须以 http:// 或 https:// 开头"
  }
  if (mode === "create" && form.agent === "codex" && !form.providerId && !form.model.trim()) return "Codex 接兼容服务必须填写模型名"
  return ""
}

// 新增请求体：选了服务商就由服务端按预设填地址、模型和附加变量
export function buildCreateBody(form: ServiceForm): Record<string, unknown> {
  const body: Record<string, unknown> = { agent: form.agent, key: form.key.trim() }
  if (form.name.trim()) body.name = form.name.trim()
  if (form.model.trim()) body.model = form.model.trim()
  if (form.mode === "subscription") body.subscription = true
  else if (form.providerId) body.providerId = form.providerId
  else body.baseUrl = form.baseUrl.trim()
  return body
}

// 编辑请求体：Key 留空表示不改
export function buildEditBody(form: ServiceForm): Record<string, unknown> {
  const body: Record<string, unknown> = { model: form.model.trim() }
  if (form.key.trim()) body.key = form.key.trim()
  if (form.mode === "subscription") body.subscription = true
  else body.baseUrl = form.baseUrl.trim()
  return body
}

export function resultTone(result: ConnectionResult): "success" | "error" {
  return result.category === "success" ? "success" : "error"
}
