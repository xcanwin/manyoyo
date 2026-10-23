import { apiUploadImage } from "@/lib/api"
import { buildRawFileUrl } from "@/lib/markdown-render"

// 聊天里的图片：选中 / 粘贴 / 拖进来时就上传，发送时只带容器内路径（上限与服务端 lib/web/uploads.js 一致）
export const MAX_CHAT_IMAGES = 5
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const UPLOAD_PATH_PATTERN = /^\/run\/manyoyo\/uploads\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/
const STORE_PREFIX = "manyoyo:composer-images:"

// 返回空串表示可以上传
export function validateChatImage(file: { type: string; size: number }): string {
  if (!ALLOWED_TYPES.includes(file.type)) return "只支持 png、jpeg、gif、webp 图片"
  if (file.size > MAX_CHAT_IMAGE_BYTES) return "图片不能超过 10MB"
  if (file.size === 0) return "图片内容为空"
  return ""
}

export async function uploadChatImage(sessionName: string, file: File): Promise<string> {
  const data = await apiUploadImage(`/api/sessions/${encodeURIComponent(sessionName)}/uploads`, file)
  const path = String(data.path ?? "")
  if (!UPLOAD_PATH_PATTERN.test(path)) throw new Error("上传结果无效")
  return path
}

// 缩略图：容器里的文件经 fs/raw 读出来（刷新页面后、历史消息里都靠它）
export const chatImageUrl = (sessionName: string, path: string) => buildRawFileUrl(sessionName, path)

// 从剪贴板 / 拖拽里取出图片文件
export function pickImageFiles(items: DataTransfer | null): File[] {
  if (!items) return []
  return Array.from(items.files ?? []).filter((file) => file.type.startsWith("image/"))
}

// 草稿里的图片只存路径
export function loadDraftImages(sessionName: string): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${STORE_PREFIX}${sessionName}`) || "[]")
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && UPLOAD_PATH_PATTERN.test(item)).slice(0, MAX_CHAT_IMAGES) : []
  } catch {
    return []
  }
}

export function saveDraftImages(sessionName: string, paths: string[]) {
  try {
    if (paths.length === 0) window.localStorage.removeItem(`${STORE_PREFIX}${sessionName}`)
    else window.localStorage.setItem(`${STORE_PREFIX}${sessionName}`, JSON.stringify(paths))
  } catch {
    // localStorage 不可用时静默降级
  }
}
