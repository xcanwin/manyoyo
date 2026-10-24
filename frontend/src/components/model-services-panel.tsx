import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  buildCreateBody,
  buildEditBody,
  createModelService,
  deleteModelService,
  EMPTY_SERVICE_FORM,
  fetchModelServices,
  fetchServiceContainers,
  resultTone,
  serviceTitle,
  testModelService,
  updateModelService,
  validateServiceForm,
  type ModelService,
  type ModelServicesData,
  type ServiceForm,
} from "@/lib/model-services"
import type { ConnectionResult } from "@/lib/setup"

type Notice = { tone: "success" | "error"; text: string }

// 系统设置里的“模型服务”：一套服务 = 一个运行配置。界面上不出现变量名；Key 只显示末 4 位，保存和测试都在服务端完成
export function ModelServicesPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [data, setData] = React.useState<ModelServicesData | null>(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [results, setResults] = React.useState<Record<string, Notice>>({})
  const [dialog, setDialog] = React.useState<{ mode: "create" | "edit"; form: ServiceForm; name?: string } | null>(null)
  const [deleting, setDeleting] = React.useState<ModelService | null>(null)

  const load = React.useCallback(() => {
    fetchModelServices()
      .then((next) => {
        setData(next)
        setError("")
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => load())
  }, [load])

  function applyChange(next: ModelServicesData) {
    setData(next)
    onSaved?.()
  }

  function noticeOf(result: ConnectionResult): Notice {
    return {
      tone: resultTone(result),
      text: result.category === "success" ? "连接成功，模型能执行命令" : result.message + (result.detail ? `（${result.detail.slice(0, 120)}）` : ""),
    }
  }

  async function handleTest(name: string) {
    setBusy(`test:${name}`)
    try {
      const result = await testModelService(name)
      setResults((prev) => ({ ...prev, [name]: noticeOf(result) }))
    } catch (err) {
      setResults((prev) => ({ ...prev, [name]: { tone: "error", text: err instanceof Error ? err.message : "测试失败" } }))
    } finally {
      setBusy("")
    }
  }

  async function handleReuse(from: string, agent: string) {
    setBusy(`reuse:${from}:${agent}`)
    setError("")
    try {
      const next = await createModelService({ reuseFrom: from, agent })
      applyChange(next)
      if (next.name) void handleTest(next.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败")
    } finally {
      setBusy("")
    }
  }

  async function handleDelete(service: ModelService) {
    setBusy(`delete:${service.name}`)
    try {
      applyChange(await deleteModelService(service.name))
      setDeleting(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
      setDeleting(null)
    } finally {
      setBusy("")
    }
  }

  function openEdit(service: ModelService) {
    setDialog({
      mode: "edit",
      name: service.name,
      form: {
        ...EMPTY_SERVICE_FORM,
        agent: service.agent,
        mode: service.authMode,
        providerId: service.providerId,
        baseUrl: service.baseUrl,
        model: service.model,
        name: service.name,
      },
    })
  }

  if (!data && !error) return <Spinner />

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        每一项是一套“服务商 + Key”。添加后可以在新建容器、快捷对话里直接选用；已有容器不受影响。
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data && data.services.length === 0 ? <p className="text-sm text-muted-foreground">还没有模型服务，点下面的“添加模型服务”。</p> : null}
      <div className="flex flex-col gap-2">
        {(data?.services ?? []).map((service) => {
          const result = results[service.name]
          return (
            <div key={service.name} className="flex flex-col gap-2 rounded-lg border p-3" data-testid={`model-service-${service.name}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold">{serviceTitle(service)}</span>
                  <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {service.authMode === "subscription" ? "订阅令牌" : "Key"} {service.keyTail || "未填写"}
                    {service.model ? ` · 模型 ${service.model}` : ""} · 配置名 {service.name}
                    {service.quickChatDefault ? " · 快捷对话在用" : ""}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => void handleTest(service.name)}>
                    {busy === `test:${service.name}` ? <Spinner /> : null}
                    测试
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => openEdit(service)}>
                    编辑
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => setDeleting(service)}>
                    删除
                  </Button>
                </div>
              </div>
              {result ? (
                <p role="status" className={result.tone === "success" ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
                  {result.text}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>

      {data && data.suggestions.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
          <span className="text-sm font-semibold">发现可以直接复用的 Key</span>
          {data.suggestions.map((item) => (
            <div key={`${item.from}:${item.agent}`} className="flex items-center justify-between gap-2">
              <span className="text-sm">{item.label}</span>
              <Button type="button" size="sm" disabled={busy !== ""} onClick={() => void handleReuse(item.from, item.agent)}>
                {busy === `reuse:${item.from}:${item.agent}` ? <Spinner /> : null}
                一键添加
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Button type="button" variant="outline" className="w-fit" onClick={() => setDialog({ mode: "create", form: EMPTY_SERVICE_FORM })}>
        添加模型服务
      </Button>

      {dialog && data ? (
        <ServiceDialog
          key={`${dialog.mode}:${dialog.name ?? ""}`}
          data={data}
          mode={dialog.mode}
          initial={dialog.form}
          name={dialog.name}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            applyChange(next)
            setDialog(null)
            if (next.name && dialog.mode === "create") void handleTest(next.name)
          }}
        />
      ) : null}

      <Dialog open={deleting !== null} onOpenChange={(open) => (open ? null : setDeleting(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除模型服务</DialogTitle>
            <DialogDescription>
              只删除这项配置“{deleting?.name}”，已有容器不受影响（它们创建时已经带上了 Key）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button type="button" disabled={busy !== ""} onClick={() => deleting && void handleDelete(deleting)}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ServiceDialog({
  data,
  mode,
  initial,
  name,
  onClose,
  onSaved,
}: {
  data: ModelServicesData
  mode: "create" | "edit"
  initial: ServiceForm
  name?: string
  onClose: () => void
  onSaved: (next: ModelServicesData) => void
}) {
  const [form, setForm] = React.useState<ServiceForm>(initial)
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  // 编辑时：还在用这个服务旧设置的容器（创建时 Key 已写进它们的环境变量，改配置不会自动跟着变）
  const [using, setUsing] = React.useState<string[]>([])
  const [sync, setSync] = React.useState(true)
  const agent = data.agents.find((item) => item.id === form.agent) ?? data.agents[0]
  const provider = agent?.providers.find((item) => item.id === form.providerId) ?? null
  const subscriptionOnly = form.mode === "subscription"
  const editing = mode === "edit"

  React.useEffect(() => {
    if (!editing || !name) return
    let cancelled = false
    fetchServiceContainers(name)
      .then((result) => {
        if (!cancelled) setUsing(result.containers ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [editing, name])

  function patch(next: Partial<ServiceForm>) {
    setError("")
    setForm((prev) => ({ ...prev, ...next }))
  }

  async function handleSave() {
    const message = validateServiceForm(form, mode)
    if (message) {
      setError(message)
      return
    }
    setSaving(true)
    try {
      onSaved(editing && name ? await updateModelService(name, buildEditBody(form, sync && using.length > 0)) : await createModelService(buildCreateBody(form)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const codexSubscription = subscriptionOnly && form.agent === "codex"

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑模型服务" : "添加模型服务"}</DialogTitle>
          <DialogDescription>Key 只保存在本机配置里，页面上只显示末 4 位。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {!editing ? (
            <Field>
              <FieldLabel>Agent</FieldLabel>
              <ToggleGroup
                variant="outline"
                size="sm"
                value={[form.agent]}
                onValueChange={(values) => values[0] && patch({ agent: String(values[0]), providerId: "", baseUrl: "", model: "", mode: "key" })}
              >
                {data.agents.map((item) => (
                  <ToggleGroupItem key={item.id} value={item.id}>
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}
          {!editing || subscriptionOnly ? (
            <Field>
              <FieldLabel>登录方式</FieldLabel>
              <ToggleGroup
                variant="outline"
                size="sm"
                value={[form.mode]}
                disabled={editing}
                onValueChange={(values) => values[0] && patch({ mode: values[0] === "subscription" ? "subscription" : "key" })}
              >
                <ToggleGroupItem value="key">API Key</ToggleGroupItem>
                <ToggleGroupItem value="subscription">订阅登录</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          ) : null}

          {subscriptionOnly ? (
            <Field>
              <FieldDescription>
                {form.agent === "claude"
                  ? "在任意有浏览器的电脑上运行 claude setup-token，把得到的长期令牌粘贴到下面；或者在容器的终端里运行 claude，按提示登录（凭据只在那个容器里）。"
                  : "在容器的终端里运行 codex login --device-auth，按提示用浏览器登录。登录只在那个容器里有效，换容器要重新登录。"}
              </FieldDescription>
            </Field>
          ) : !editing ? (
            <Field>
              <FieldLabel>服务商</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {(agent?.providers ?? []).map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="xs"
                    variant={form.providerId === item.id ? "default" : "outline"}
                    onClick={() => patch({ providerId: item.id, baseUrl: item.baseUrl, model: form.model || item.defaultModel })}
                  >
                    {item.label}
                  </Button>
                ))}
                <Button type="button" size="xs" variant={form.providerId === "" ? "default" : "outline"} onClick={() => patch({ providerId: "", baseUrl: "" })}>
                  自定义地址
                </Button>
              </div>
              {provider ? (
                <FieldDescription>
                  <a href={provider.docUrl} target="_blank" rel="noreferrer" className="underline">
                    官方说明
                  </a>
                  {provider.extraEnv && Object.keys(provider.extraEnv).length > 0 ? "；已自动带上这家服务需要的附加设置" : ""}
                </FieldDescription>
              ) : null}
            </Field>
          ) : null}

          {!subscriptionOnly && (!provider || editing) ? (
            <Field>
              <FieldLabel htmlFor="ms-base-url">Base URL</FieldLabel>
              <Input id="ms-base-url" value={form.baseUrl} placeholder="https://…" onChange={(event) => patch({ baseUrl: event.target.value })} />
            </Field>
          ) : null}

          {!codexSubscription ? (
            <>
              <Field>
                <FieldLabel htmlFor="ms-key">{subscriptionOnly ? "订阅令牌" : "API Key"}</FieldLabel>
                <Input
                  id="ms-key"
                  type="password"
                  autoComplete="off"
                  value={form.key}
                  placeholder={editing ? "留空表示不修改" : ""}
                  onChange={(event) => patch({ key: event.target.value })}
                />
                {subscriptionOnly && form.agent === "claude" ? (
                  <FieldDescription>保存后会删掉同一项里的 API Key 和 Base URL，否则 Claude Code 会优先用 Key，订阅不生效。</FieldDescription>
                ) : null}
              </Field>
              {!subscriptionOnly ? (
                <Field>
                  <FieldLabel htmlFor="ms-model">模型</FieldLabel>
                  <Input
                    id="ms-model"
                    value={form.model}
                    placeholder={provider?.models[0] || (form.agent === "codex" ? "Codex 接兼容服务必须填写" : "可选")}
                    onChange={(event) => patch({ model: event.target.value })}
                  />
                </Field>
              ) : null}
              {editing && using.length > 0 ? (
                <Field orientation="horizontal">
                  <input id="ms-sync" type="checkbox" checked={sync} onChange={(event) => setSync(event.target.checked)} />
                  <FieldLabel htmlFor="ms-sync">同时更新 {using.length} 个还在用旧设置的容器（{using.join("、")}），下一轮对话生效</FieldLabel>
                </Field>
              ) : null}
              {!editing ? (
                <Field>
                  <FieldLabel htmlFor="ms-name">名字</FieldLabel>
                  <Input id="ms-name" value={form.name} placeholder="留空自动生成" onChange={(event) => patch({ name: event.target.value })} />
                  <FieldDescription>也是运行配置的名字，命令行用 manyoyo run -r 名字 启动。</FieldDescription>
                </Field>
              ) : null}
            </>
          ) : null}
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          {!codexSubscription ? (
            <Button type="button" disabled={saving} onClick={() => void handleSave()}>
              {saving ? <Spinner /> : null}
              保存
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
