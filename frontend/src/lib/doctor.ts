import { apiGet, apiPost } from "@/lib/api"

export type DoctorFix = { attempted: boolean; fixed: boolean; message: string }
export type DoctorCheck = {
  code: string
  status: "ok" | "warning" | "error"
  summary: string
  action: string
  detail: string
  fix?: DoctorFix
}
export type DoctorReport = { ok: boolean; checks: DoctorCheck[] }

export const STATUS_LABEL: Record<DoctorCheck["status"], string> = { ok: "通过", warning: "警告", error: "失败" }

// 有可自动处理的问题才显示“尝试自动修复”
const FIXABLE_CODES = new Set(["DAEMON_UNAVAILABLE", "IMAGE_MISSING"])
export function hasFixableIssue(report: DoctorReport | null): boolean {
  return Boolean(report?.checks.some((check) => check.status !== "ok" && FIXABLE_CODES.has(check.code) && !check.fix?.fixed))
}

export const fetchDoctor = async () => (await apiGet("/api/system/doctor")) as unknown as DoctorReport
export const runDoctorFix = async () => (await apiPost("/api/system/doctor/fix", {})) as unknown as DoctorReport
