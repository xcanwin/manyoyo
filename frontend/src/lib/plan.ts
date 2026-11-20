// 会话计划面板的类型与纯函数。计划由服务端根据执行过程生成并写入文件（lib/web/plan.js），这里只做展示和分组。
export type PlanStatus = "pending" | "in_progress" | "completed"

export type PlanItem = {
  id: string
  subject: string
  status: PlanStatus
  source: "agent"
  updatedAt: string | null
  ref?: { messageId?: string; toolId?: string }
}

export type PlanDod = {
  id: string
  text: string
  note: string
  checked: boolean
  checkedAt: string | null
  checkedBy: "user"
}

export type Plan = {
  version: 1
  revision: number
  updatedAt: string | null
  items: PlanItem[]
  dod: PlanDod[]
}

export type PlanPayload = { plan: Plan; etag: string }

export const emptyPlan = (): Plan => ({ version: 1, revision: 0, updatedAt: null, items: [], dod: [] })

export function normalizePlan(value: unknown): Plan {
  const source = (value && typeof value === "object" ? value : {}) as Partial<Plan>
  return {
    version: 1,
    revision: typeof source.revision === "number" ? source.revision : 0,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
    items: Array.isArray(source.items) ? source.items : [],
    dod: Array.isArray(source.dod) ? source.dod : [],
  }
}

export function groupPlanItems(items: PlanItem[]): Array<{ status: PlanStatus; label: string; items: PlanItem[] }> {
  return [
    { status: "in_progress" as const, label: "进行中", items: items.filter((item) => item.status === "in_progress") },
    { status: "pending" as const, label: "待办", items: items.filter((item) => item.status === "pending") },
    { status: "completed" as const, label: "已完成", items: items.filter((item) => item.status === "completed") },
  ].filter((group) => group.items.length > 0)
}
