import { apiDelete, apiGet, apiPost } from "@/lib/api"

// 容器导出 / 导入：档位与内容项由服务端下发（lib/archive/plan.js 是唯一数据源），这里只做渲染用的纯函数和接口封装

export type TransferTier = { id: string; label: string; recommended?: boolean }
export type TransferItem = { id: string; label: string; hint: string; tiers: string[] }
export type TransferPreview = {
  tiers: TransferTier[]
  items: TransferItem[]
  // 每项的估算字节数；null = 未知（容器里的数据要读改动才知道）
  estimates: Record<string, number | null>
  // status：running | paused | stopped | history | busy（busy = 正在导出 / 导入）
  containers: { name: string; remark: string; status: string }[]
  zstd: boolean
  freeBytes: number | null
}

export type TransferJob = {
  id: string
  type: "export" | "import"
  status: "preparing" | "ready" | "waiting" | "running" | "done" | "failed" | "cancelled" | "interrupted"
  containers: string[]
  stage: string
  container: string
  bytes: number
  estimate: number
  // false = 估算不含容器内数据，不能显示百分比
  estimateComplete: boolean
  error: string
  result: Record<string, unknown> | null
  cancelRequested: boolean
  output: "download" | "server" | ""
  downloadUrl: string
  uploadUrl: string
  warnings: string[]
}

export type ImportDetail = {
  name: string
  oldName?: string
  dropped: string[]
  layerSkippedSystem: number
  imageUsed?: string
  sameImage?: boolean
}

// 容器状态的中文名：认 docker 的状态文本（Up 3 hours (Paused)）和预览接口的枚举
export function statusLabel(status: string): string {
  if (status === "history") return "仅历史"
  if (status === "busy") return "正在导出 / 导入"
  if (/paused/i.test(status)) return "已暂停"
  if (status === "running" || /^Up\b/.test(status)) return "运行中"
  return "已停止"
}

// 原始报错不给用户看：连接类的底层错误统一换成一句人话
export function friendlyError(message: string, fallback = "出错了，请重试"): string {
  const text = String(message || "").trim()
  if (!text) return fallback
  if (/Premature close|EBADF|EPIPE|ECONN|ETIMEDOUT|socket hang up|Failed to fetch|NetworkError|aborted/i.test(text))
    return "连接中断了，请重试"
  return text
}

// 导入结束后没能还原的内容，一条一句话
export function importDropLines(result: Record<string, unknown> | null): string[] {
  const details = result && Array.isArray(result.details) ? (result.details as ImportDetail[]) : []
  const lines: string[] = []
  for (const detail of details) {
    const name = detail.name || detail.oldName || ""
    for (const item of detail.dropped || []) lines.push(`${name}：${item}`)
    if (detail.layerSkippedSystem > 0)
      lines.push(`${name}：用了默认镜像，${detail.layerSkippedSystem} 个系统层文件没有还原`)
  }
  return lines
}

// 已经自动触发过下载的任务：进度弹窗和侧栏都会看到 ready，下载链接只能用一次，所以每个任务只自动触发一次
const autoDownloaded = new Set<string>()
export function autoDownloadOnce(jobId: string, url: string): boolean {
  if (!url || autoDownloaded.has(jobId)) return false
  autoDownloaded.add(jobId)
  triggerDownload(url)
  return true
}

// 交给浏览器下载（可能被拦截，调用方要另给一个手动入口）
export function triggerDownload(url: string) {
  const link = document.createElement("a")
  link.href = url
  link.download = ""
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export type ImportRisks = {
  containerMode?: string
  volumes?: string[]
  ports?: string[]
  autostart?: boolean
  envFiles?: string[]
  networkOpen?: boolean
}

export type ImportContainer = {
  idx: number
  name: string
  remark: string
  image: string
  containerPath: string
  hostPath: string
  fidelity: "full" | "partial"
  work: number | null
  nameTaken: boolean
  suggestedName: string
  suggestedHostPath: string
  imageStatus?: "present" | "missing" | "untrusted" | "unknown"
  risks: ImportRisks
}

export type ImportInspect = {
  manyoyoVersion: string
  createdAt: string
  items: string[]
  tier: string
  includeSecrets: boolean
  containers: ImportContainer[]
  localImage: string
}

export type ImportConfirm = {
  containerMode?: string
  volumes: string[]
  ports: boolean
  autostart: boolean
  envFiles: string[]
  networkOpen: boolean
}

export type ImportPlanEntry = {
  name: string
  remark: string
  hostPath: string
  imageMode: "same" | "default"
  confirm: ImportConfirm
}

export const itemsOfTier = (items: TransferItem[], tier: string) =>
  items.filter((item) => item.tiers.includes(tier)).map((item) => item.id)

// 勾选集合正好等于某档就返回那一档，否则 "custom"
export function matchTier(
  items: TransferItem[],
  tiers: TransferTier[],
  selected: string[]
): string {
  const set = new Set(selected)
  for (const tier of tiers) {
    const expected = itemsOfTier(items, tier.id)
    if (expected.length === set.size && expected.every((id) => set.has(id)))
      return tier.id
  }
  return "custom"
}

// 已勾选内容的估算合计：unknown 表示有一项服务端给不出大小
export function estimateTotal(
  estimates: Record<string, number | null>,
  selected: string[]
): { bytes: number; unknown: boolean } {
  let bytes = 0
  let unknown = false
  for (const id of selected) {
    const value = estimates[id]
    if (value === null || value === undefined) unknown = true
    else bytes += value
  }
  return { bytes, unknown }
}

export const fetchPreview = (names: string[]) =>
  apiGet(
    `/api/transfer/preview?containers=${encodeURIComponent(names.join(","))}`
  ) as unknown as Promise<TransferPreview>

export type ExportRequest = {
  containers: string[]
  items: string[]
  includeSecrets: boolean
  compression: "fast" | "small"
  output: "download" | "server"
}

export const startExport = (body: ExportRequest) =>
  apiPost("/api/exports", body) as unknown as Promise<{ jobId: string; output: string }>

export const fetchJob = (id: string) =>
  apiGet(`/api/jobs/${id}`).then((data) => data.job as TransferJob)

export const cancelJob = (id: string) => apiPost(`/api/jobs/${id}/cancel`, {})

export type ServerExportFile = { name: string; size: number; mtime: string }
export const listServerExports = () =>
  apiGet("/api/exports") as unknown as Promise<{
    dir: string
    files: ServerExportFile[]
    freeBytes: number | null
  }>
export const deleteServerExport = (name: string) =>
  apiDelete(`/api/exports/files/${encodeURIComponent(name)}`)

export const inspectServerFile = (serverFile: string) =>
  apiPost("/api/imports/inspect", { serverFile }) as unknown as Promise<ImportInspect>

// 本机文件：只上传开头 4MB 看清单
export async function inspectLocalFile(file: File): Promise<ImportInspect> {
  const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer()
  const response = await fetch("/api/imports/inspect", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: head,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || "读取文件失败")
  return data as ImportInspect
}

export function buildImportPlan(
  entries: Record<number, ImportPlanEntry>
): { containers: Record<number, ImportPlanEntry> } {
  return { containers: entries }
}

export function startServerImport(
  serverFile: string,
  plan: ReturnType<typeof buildImportPlan>
) {
  return apiPost("/api/imports", { serverFile, plan }) as unknown as Promise<{ jobId: string }>
}

// 上传导入第一步：登记设置、预留新名字，拿到上传地址
export const startUploadImport = (plan: ReturnType<typeof buildImportPlan>) =>
  apiPost("/api/imports/uploads", { plan }) as unknown as Promise<{ jobId: string; uploadUrl: string }>

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// 上传导入第二步：XHR 才有上传进度。请求体收完后服务端回 202，之后轮询任务
// jobId：登记时拿到的任务号。经反向代理时，条目很多的小归档可能让代理在服务端处理期间先超时（502 / 504），
// 但服务端的导入任务还在跑——这种情况不当成失败，让调用方去看任务进度
export function uploadImportFile(
  file: File,
  uploadUrl: string,
  onProgress: (loaded: number, total: number) => void,
  jobId = ""
): { promise: Promise<{ jobId: string }>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<{ jobId: string }>((resolve, reject) => {
    xhr.open("POST", uploadUrl)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest")
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onerror = () => reject(new Error("上传中断，导入已撤销"))
    xhr.onabort = () => reject(new Error("已取消，导入已撤销"))
    xhr.onload = () => {
      const data = parseJsonObject(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { jobId: string })
      else if ((xhr.status === 502 || xhr.status === 504) && jobId) resolve({ jobId })
      else if (xhr.status === 413)
        reject(
          new Error(
            "文件太大，被反向代理拦下了。先把文件放到服务器的 ~/.manyoyo/exports/，再选“服务器上的文件”"
          )
        )
      else reject(new Error(friendlyError(String(data.error || ""), `导入失败（${xhr.status}）`)))
    }
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

// 需要用户逐项确认的高风险设置（有就必须勾，没勾的导入时会被去掉）
export function riskItems(container: ImportContainer): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const r = container.risks || {}
  if (r.containerMode === "sock")
    out.push({ key: "mode:sock", label: "可访问宿主机的 Docker（sock 模式，有安全风险）" })
  if (r.containerMode === "dind")
    out.push({ key: "mode:dind", label: "特权容器（dind 模式，有安全风险）" })
  for (const volume of r.volumes || [])
    out.push({ key: `volume:${volume}`, label: `额外挂载 ${volume}` })
  if ((r.ports || []).length)
    out.push({ key: "ports", label: `端口映射 ${(r.ports || []).join("、")}` })
  if (r.autostart) out.push({ key: "autostart", label: "自启动脚本（容器每次启动都会运行）" })
  for (const file of r.envFiles || [])
    out.push({ key: `envfile:${file}`, label: `环境变量文件 ${file}（本机文件，内容会进容器环境）` })
  if (r.networkOpen) out.push({ key: "networkOpen", label: "自定义网络规则（可能放开出站访问，包括内网）" })
  return out
}

export function confirmFromChecked(
  container: ImportContainer,
  checked: Set<string>
): ImportConfirm {
  const r = container.risks || {}
  return {
    containerMode:
      r.containerMode && checked.has(`mode:${r.containerMode}`) ? r.containerMode : undefined,
    volumes: (r.volumes || []).filter((volume) => checked.has(`volume:${volume}`)),
    ports: checked.has("ports"),
    autostart: checked.has("autostart"),
    envFiles: (r.envFiles || []).filter((file) => checked.has(`envfile:${file}`)),
    networkOpen: checked.has("networkOpen"),
  }
}
