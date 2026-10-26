import { sessionDisplayTitle, type ContainerGroup, type SessionSummary } from "@/lib/api"

// 侧栏排序：容器层排容器，AGENT 层排当前容器里的 AGENT；置顶的永远在最前
export type SortKey = "name" | "created" | "updated"
export type SidebarSort = { containers: SortKey; agents: SortKey }

export const DEFAULT_SIDEBAR_SORT: SidebarSort = { containers: "updated", agents: "updated" }
export const SIDEBAR_SORT_STORAGE_KEY = "manyoyo.web.sidebarSort.v1"
export const SORT_LABELS: Record<SortKey, string> = {
  name: "按名称",
  created: "按创建时间",
  updated: "按修改时间",
}

const isSortKey = (value: unknown): value is SortKey => value === "name" || value === "created" || value === "updated"

export function loadSidebarSort(): SidebarSort {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY)
    if (!raw) return DEFAULT_SIDEBAR_SORT
    const parsed = JSON.parse(raw) as { containers?: unknown; agents?: unknown } | null
    return {
      containers: isSortKey(parsed?.containers) ? parsed.containers : DEFAULT_SIDEBAR_SORT.containers,
      agents: isSortKey(parsed?.agents) ? parsed.agents : DEFAULT_SIDEBAR_SORT.agents,
    }
  } catch {
    return DEFAULT_SIDEBAR_SORT
  }
}

export function saveSidebarSort(sort: SidebarSort): void {
  try {
    window.localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, JSON.stringify(sort))
  } catch {
    // 存储不可用时只是不记住偏好
  }
}

const timeOf = (value: string | null | undefined) => {
  const time = value ? new Date(value).getTime() : NaN
  return Number.isNaN(time) ? 0 : time
}
const compareName = (a: string, b: string) => a.localeCompare(b, "zh-CN")

export const containerDisplayName = (group: Pick<ContainerGroup, "containerRemark" | "containerName">) =>
  group.containerRemark || group.containerName

// 容器创建时间：服务端给的真实值；仅剩历史的容器退回组内最早的 AGENT 创建时间
export function containerCreatedTime(group: Pick<ContainerGroup, "containerCreatedAt" | "sessions">): number {
  const own = timeOf(group.containerCreatedAt)
  if (own) return own
  const times = group.sessions.map((s) => timeOf(s.createdAt)).filter(Boolean)
  return times.length ? Math.min(...times) : 0
}

export function sortContainerGroups(groups: ContainerGroup[], key: SortKey): ContainerGroup[] {
  return [...groups].sort((a, b) => {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    if (pinned) return pinned
    if (key === "name") return compareName(containerDisplayName(a), containerDisplayName(b)) || compareName(a.containerName, b.containerName)
    if (key === "created") return containerCreatedTime(b) - containerCreatedTime(a)
    return timeOf(b.updatedAt) - timeOf(a.updatedAt)
  })
}

export function sortAgentSessions(sessions: SessionSummary[], key: SortKey): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const pinned = Number(b.pinned === true) - Number(a.pinned === true)
    if (pinned) return pinned
    if (key === "name") return compareName(sessionDisplayTitle(a), sessionDisplayTitle(b))
    if (key === "created") return timeOf(b.createdAt) - timeOf(a.createdAt)
    return timeOf(b.updatedAt) - timeOf(a.updatedAt)
  })
}
