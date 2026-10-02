export type StageState = "done" | "todo" | "blocked" | "warn"

export type Stage = {
  id: string
  title: string
  description: string
  external: boolean
  state: StageState
  detail: string
  url?: string
}

export type DirtyFile = { code: string; path: string }
export type Suggestion = { key: string; label: string; version: string; recommended: boolean }
export type ChecklistItem = { id: string; title: string; done: boolean }

export type JobSnapshot = {
  id: string
  mode: "single" | "step" | "auto"
  stages: string[]
  status: "running" | "succeeded" | "failed" | "cancelled"
  currentStage: string | null
  error: string
  confirm: { stage: string; title: string; commands: string[] } | null
} | null

export type Status = {
  version: string
  imageVersion: string
  branch: string
  latestTag: string | null
  dryRun: boolean
  gh: boolean
  stages: Stage[]
  nextStage: string | null
  dirty: DirtyFile[]
  ruleMessage: string
  suggestions: Suggestion[]
  notesDraft: string
  checklist: ChecklistItem[]
  job: JobSnapshot
}

export type ReleaseEvent =
  | { seq: number; type: "start"; mode: string; stages: string[] }
  | { seq: number; type: "log"; stage: string; line: string }
  | { seq: number; type: "stage"; stage: string; state: string; result?: string; detail?: string }
  | { seq: number; type: "confirm"; stage: string; title: string; commands: string[] }
  | { seq: number; type: "done"; status: string; error?: string }

declare global {
  interface Window {
    __RELEASE__?: { token: string }
  }
}

const token = () => window.__RELEASE__?.token ?? ""

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Release-Token": token(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((data as { error?: string }).error || `请求失败 (${response.status})`)
  return data as T
}

export function subscribeEvents(onEvent: (event: ReleaseEvent) => void): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token())}`)
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as ReleaseEvent)
  return () => source.close()
}
