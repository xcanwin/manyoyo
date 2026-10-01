import { apiGet, apiPost } from "@/lib/api"

export type MirrorTool = "apt" | "npm" | "pip"
export type Mirrors = Record<MirrorTool, string>
export type MirrorPreset = { label: string; value: string }
export type MirrorPresets = Record<MirrorTool, MirrorPreset[]>

export const MIRROR_TOOLS: { id: MirrorTool; label: string; hint: string }[] = [
  { id: "apt", label: "apt（系统软件包）", hint: "只填镜像站主机，例如 https://mirrors.aliyun.com" },
  { id: "npm", label: "npm", hint: "例如 https://registry.npmmirror.com/" },
  { id: "pip", label: "pip", hint: "例如 https://pypi.tuna.tsinghua.edu.cn/simple" },
]

export const OFFICIAL_CHOICE = ""
export const CUSTOM_CHOICE = "__custom__"
const MAX_URL_LENGTH = 256

export const emptyMirrors = (): Mirrors => ({ apt: "", npm: "", pip: "" })
export const emptyPresets = (): MirrorPresets => ({ apt: [], npm: [], pip: [] })

// 下拉当前选项：空 = 官方默认；等于某个预设的值 = 该预设；其它 = 自定义
export function choiceFor(value: string, presets: MirrorPreset[]): string {
  if (!value) return OFFICIAL_CHOICE
  return presets.some((item) => item.value === value) ? value : CUSTOM_CHOICE
}

// 与服务端 normalizeMirrors 的规则一致；空 = 官方默认，合法返回空串，否则给出原因
export function validateMirrorUrl(value: string): string {
  const text = value.trim()
  if (!text) return ""
  if (!/^https?:\/\//i.test(text)) return "地址必须以 http:// 或 https:// 开头"
  if (text.length > MAX_URL_LENGTH) return `地址过长（最多 ${MAX_URL_LENGTH} 个字符）`
  if (/[\s\0;&|`$<>'"\\]/.test(text)) return "地址含非法字符（空白、引号、反斜杠和 ; & | ` $ < >）"
  try {
    new URL(text)
  } catch {
    return "不是有效的 URL"
  }
  return ""
}

export function validateMirrors(mirrors: Mirrors): string {
  for (const tool of MIRROR_TOOLS) {
    const reason = validateMirrorUrl(mirrors[tool.id])
    if (reason) return `${tool.label}：${reason}`
  }
  return ""
}

export const isMirrorsEmpty = (mirrors: Mirrors) => !mirrors.apt && !mirrors.npm && !mirrors.pip

export const fetchMirrorPresets = async () =>
  ((await apiGet("/api/setup/agents")).mirrorPresets ?? emptyPresets()) as unknown as MirrorPresets
export const saveMirrors = (mirrors: Mirrors) =>
  apiPost("/api/setup/mirrors", {
    mirrors: { apt: mirrors.apt.trim(), npm: mirrors.npm.trim(), pip: mirrors.pip.trim() },
  })
