import * as React from "react"
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { apiErrorData, apiGet, apiPut, type SessionSummary } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { emptyPlan, groupPlanItems, normalizePlan, type Plan, type PlanDod, type PlanPayload } from "@/lib/plan"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Hint } from "@/components/hint"
import { PageHeader } from "@/components/page-header"
import { TaskStatusIcon } from "@/components/trace-block"

// “计划”视图：服务端保存的 Agent 计划投影（TodoWrite / TaskCreate / TaskUpdate）+ 用户维护的验收清单。
// 计划项是 Agent 产出的不可信文本，只按纯文本渲染，不走 Markdown / innerHTML。
export function PlanPanel({
  session,
  livePlan,
  onDirtyChange,
}: {
  session: SessionSummary
  livePlan?: Plan | null
  onDirtyChange?: (dirty: boolean) => void
}) {
  const base = `/api/sessions/${encodeURIComponent(session.name)}/plan`
  const [plan, setPlan] = React.useState<Plan>(emptyPlan)
  const [etag, setEtag] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirtyState] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [stale, setStale] = React.useState(false)
  const dirtyRef = React.useRef(false)
  const seqRef = React.useRef(0)

  const setDirty = React.useCallback(
    (value: boolean) => {
      dirtyRef.current = value
      setDirtyState(value)
      onDirtyChange?.(value)
    },
    [onDirtyChange]
  )

  const load = React.useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const data = (await apiGet(base)) as unknown as PlanPayload
      if (seq !== seqRef.current) return
      setPlan(normalizePlan(data.plan))
      setEtag(String(data.etag || ""))
      setDirty(false)
      setConflict(false)
      setStale(false)
      setError("")
    } catch (err) {
      if (seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : "读取计划失败")
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [base, setDirty])

  React.useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  // Agent 的计划变了：没有未保存修改就重新拉一次（要新的 etag）；有修改只提示，不覆盖用户的草稿
  React.useEffect(() => {
    if (!livePlan) return
    if (dirtyRef.current) {
      setStale(true)
      return
    }
    queueMicrotask(() => void load())
  }, [livePlan, load])

  React.useEffect(
    () => () => {
      onDirtyChange?.(false)
    },
    [onDirtyChange]
  )

  function updateDod(index: number, patch: Partial<PlanDod>) {
    setPlan((prev) => ({
      ...prev,
      dod: prev.dod.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }))
    setDirty(true)
  }

  function addDod() {
    setPlan((prev) => ({
      ...prev,
      dod: [...prev.dod, { id: "", text: "", note: "", checked: false, checkedAt: null, checkedBy: "user" }],
    }))
    setDirty(true)
  }

  function removeDod(index: number) {
    setPlan((prev) => ({ ...prev, dod: prev.dod.filter((_, i) => i !== index) }))
    setDirty(true)
  }

  async function save(etagOverride?: string) {
    if (saving) return
    setSaving(true)
    setError("")
    try {
      const data = (await apiPut(
        `${base}/dod`,
        {
          items: plan.dod.map((item) => ({
            ...(item.id ? { id: item.id } : {}),
            text: item.text,
            note: item.note,
            checked: item.checked,
            ...(item.checkedAt ? { checkedAt: item.checkedAt } : {}),
          })),
        },
        { "If-Match": etagOverride ?? etag }
      )) as unknown as PlanPayload
      setPlan(normalizePlan(data.plan))
      setEtag(String(data.etag || ""))
      setDirty(false)
      setConflict(false)
      setStale(false)
    } catch (err) {
      const { status } = apiErrorData(err)
      if (status === 409) {
        setConflict(true)
        return
      }
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function saveOverriding() {
    try {
      const latest = (await apiGet(base)) as unknown as PlanPayload
      await save(String(latest.etag || ""))
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    }
  }

  const completed = plan.items.filter((item) => item.status === "completed").length
  const groups = groupPlanItems(plan.items)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 md:p-4">
        <PageHeader
          title="计划"
          description="查看 AGENT 的计划与进度，并维护自己的验收标准。"
          actions={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="刷新"
              title="刷新"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? <Spinner /> : <RefreshCwIcon />}
            </Button>
          }
        />
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {stale ? (
          <Alert variant="warning">
            <AlertDescription>Agent 更新了计划。你有还没保存的验收标准，保存或重新加载后再看最新进度。</AlertDescription>
          </Alert>
        ) : null}
        {conflict ? (
          <Alert variant="warning">
            <AlertDescription>计划已在别处更新，你保存的是旧版本。可以重新加载最新计划，或用你的内容覆盖。</AlertDescription>
            <AlertAction>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={saving}>
                  重新加载
                </Button>
                <Button variant="outline" size="sm" onClick={() => void saveOverriding()} disabled={saving}>
                  仍然保存
                </Button>
              </div>
            </AlertAction>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>进度</CardTitle>
            <CardDescription>AGENT 计划项的完成数与最近更新时间。</CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !etag ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="flex flex-col gap-2">
                <span className="font-mono">
                  {completed} / {plan.items.length}
                </span>
                <Hint>最近更新：{plan.updatedAt ? formatDateTime(plan.updatedAt) : "—"}</Hint>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>当前计划</CardTitle>
            <CardDescription>来自 Claude 的 TodoWrite / TaskCreate / TaskUpdate。</CardDescription>
          </CardHeader>
          <CardContent>
            {!plan.items.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>当前 Agent 还没有提供计划</EmptyTitle>
                  <EmptyDescription>只有 Claude 的 TodoWrite / TaskCreate / TaskUpdate 会被记录。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((group) => (
                  <div key={group.status} className="flex flex-col gap-2">
                    <Hint>{group.label}</Hint>
                    {group.items.map((item) => (
                      <div key={item.id} className="flex items-start gap-2" data-plan-item={item.id}>
                        <TaskStatusIcon status={item.status} />
                        <span className={item.status === "completed" ? "text-muted-foreground line-through" : undefined}>
                          {item.subject}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>验收标准</CardTitle>
            <CardDescription>你自己维护的完成条件；只记录和展示，不会阻塞 AGENT 执行。</CardDescription>
          </CardHeader>
          <CardContent>
            {!plan.dod.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有验收标准</EmptyTitle>
                  <EmptyDescription>添加一条完成条件，只有你自己勾选；它不会阻塞 Agent 执行。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-4">
                {plan.dod.map((item, index) => (
                  <div key={item.id || `new-${index}`} className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        aria-label="完成"
                        checked={item.checked}
                        onCheckedChange={(checked) => updateDod(index, { checked: Boolean(checked) })}
                      />
                    </div>
                    <Input
                      aria-label="验收标准"
                      placeholder="例如：测试全部通过"
                      value={item.text}
                      onChange={(event) => updateDod(index, { text: event.target.value })}
                    />
                    <Input
                      aria-label="备注"
                      placeholder="备注（可选）"
                      value={item.note}
                      onChange={(event) => updateDod(index, { note: event.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除"
                      title="删除"
                      className="self-end sm:self-auto"
                      onClick={() => removeDod(index)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="pt-4">
              <Button type="button" variant="outline" size="sm" onClick={addDod}>
                <PlusIcon data-icon="inline-start" />
                添加一条
              </Button>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? <Spinner /> : null}
              保存验收标准
            </Button>
            {dirty ? <Hint>有未保存的修改</Hint> : null}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
