import { apiDelete, apiGet, apiPost } from "@/lib/api"

// 容器导出 / 导入：档位与内容项由服务端下发（lib/archive/plan.js 是唯一数据源），这里只做渲染用的纯函数和接口封装

export type TransferTier = { id: string; label: string; recommended?: boolean }
export type TransferItem = { id: string; label: string; hint: string; tiers: string[] }
export type TransferPreview = {
  tiers: TransferTier[]
  items: TransferItem[]
  // 每项的估算字节数；null = 未知（容器里的数据要读改动才知道）
  estimates: Record<string, number | null>
  containers: { name: string; remark: string; status: string }[]
  zstd: boolean
  freeBytes: number | null
}

export type TransferJob = {
  id: string
  type: "export" | "import"
  status: "waiting" | "running" | "done" | "failed" | "cancelled" | "interrupted"
  containers: string[]
  stage: string
  container: string
  bytes: number
  estimate: number
  error: string
  result: Record<string, unknown> | null
  cancelRequested: boolean
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
  estimate: number
}

export const startExport = (body: ExportRequest) =>
  apiPost("/api/exports", body) as unknown as Promise<{
    jobId: string
    output: string
    downloadUrl?: string
    file?: string
  }>

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
  return apiPost("/api/imports", { serverFile, plan }) as unknown as Promise<{
    jobId: string
    containers: string[]
  }>
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// 上传并导入：XHR 才有上传进度。服务端边收边解包，响应在全部处理完后才回来
export function uploadImport(
  file: File,
  plan: ReturnType<typeof buildImportPlan>,
  onProgress: (loaded: number, total: number) => void
): { promise: Promise<{ jobId: string; containers: string[] }>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<{ jobId: string; containers: string[] }>(
    (resolve, reject) => {
      xhr.open(
        "POST",
        `/api/imports?plan=${encodeURIComponent(JSON.stringify(plan))}`
      )
      xhr.setRequestHeader("Content-Type", "application/octet-stream")
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest")
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      }
      xhr.onerror = () => reject(new Error("上传中断，导入已撤销"))
      xhr.onabort = () => reject(new Error("已取消，导入已撤销"))
      xhr.onload = () => {
        const data = parseJsonObject(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300)
          resolve(data as { jobId: string; containers: string[] })
        else if (xhr.status === 413)
          reject(
            new Error(
              "文件太大，被反向代理拦下了。先把文件放到服务器的 ~/.manyoyo/exports/，再选“服务器上的文件”"
            )
          )
        else reject(new Error(String(data.error || `导入失败（${xhr.status}）`)))
      }
      xhr.send(file)
    }
  )
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
