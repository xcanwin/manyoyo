import * as React from "react"

import { toast } from "sonner"
import { PencilIcon, PlayIcon, Trash2Icon } from "lucide-react"

import { DataTable, type DataColumn } from "@/components/data-table"
import { CodeBlock } from "@/components/code-block"
import { Hint } from "@/components/hint"
import { SectionToggle } from "@/components/section-toggle"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  buildCreateBody,
  buildEditBody,
  createModelService,
  deleteModelService,
  EMPTY_SERVICE_FORM,
  fetchModelServices,
  fetchImportPreview,
  fetchServiceContainers,
  importLocalServices,
  resultTone,
  serviceTitle,
  testModelService,
  updateModelService,
  validateServiceForm,
  AUTO_COMPACT_HINT,
  CLAUDE_MODEL_FIELDS,
  EMPTY_CLAUDE_MODELS,
  type ImportPreview,
  type ModelService,
  type ModelServicesData,
  type ServiceForm,
} from "@/lib/model-services"
import { envLabel } from "@/lib/config-labels"
import type { ConnectionResult } from "@/lib/setup"


// 服务商下拉里“自定义地址”这一项的取值
const CUSTOM_PROVIDER = "__custom__"

type Notice = { tone: "success" | "error"; text: string; detail?: string }

// 系统设置里的“模型服务”：一套服务 = 一个运行配置。界面上不出现变量名；Key 只显示末 4 位，保存和测试都在服务端完成
// 系统设置里的“模型服务”：一套服务 = 一个运行配置。界面上不出现变量名；Key 只显示末 4 位，保存和测试都在服务端完成
export function ModelServicesPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [data, setData] = React.useState<ModelServicesData | null>(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [results, setResults] = React.useState<Record<string, Notice>>({})
  const [dialog, setDialog] = React.useState<{
    mode: "create" | "edit"
    form: ServiceForm
    name?: string
  } | null>(null)
  const [deleting, setDeleting] = React.useState<ModelService | null>(null)
  const [importing, setImporting] = React.useState<ImportPreview | null>(null)

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
      text:
        result.category === "success"
          ? "连接成功，模型能执行命令"
          : result.message,
      // 原始报错放进可展开的详情，主提示只留人话
      detail: result.category === "success" ? "" : result.detail,
    }
  }

  async function handleTest(name: string) {
    setBusy(`test:${name}`)
    try {
      const result = await testModelService(name)
      const notice = noticeOf(result)
      setResults((prev) => ({ ...prev, [name]: notice }))
      if (notice.tone === "success") toast.success(`${name}：${notice.text}`)
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [name]: {
          tone: "error",
          text: err instanceof Error ? err.message : "测试失败",
        },
      }))
    } finally {
      setBusy("")
    }
  }

  async function handleFix(name: string) {
    setBusy(`fix:${name}`)
    try {
      applyChange(await updateModelService(name, { applyPresetExtras: true }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "修复失败")
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
      toast.success(`已删除 ${service.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
      setDeleting(null)
    } finally {
      setBusy("")
    }
  }

  async function openImport() {
    setBusy("import")
    setError("")
    try {
      setImporting(await fetchImportPreview())
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取本机配置失败")
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
        models: { ...EMPTY_CLAUDE_MODELS, ...(service.models ?? {}) },
        autoCompactWindow: service.autoCompactWindow ?? "",
      },
    })
  }

  const services = data?.services ?? []
  const fixable = services.filter(
    (service) => Object.keys(service.missingExtraEnv ?? {}).length > 0
  )
  const failed = services.filter(
    (service) => results[service.name]?.tone === "error"
  )

  // 状态：测试过的显示结果，没测过的显示“未测试”；缺附加设置的显示“需要修复”
  function statusOf(service: ModelService) {
    const result = results[service.name]
    if (busy === `test:${service.name}`) return <Spinner />
    if (result) {
      return (
        <Badge variant={result.tone === "success" ? "success" : "destructive"}>
          {result.tone === "success" ? "可用" : "不可用"}
        </Badge>
      )
    }
    if (Object.keys(service.missingExtraEnv ?? {}).length > 0) {
      return <Badge variant="warning">需要修复</Badge>
    }
    return <Badge variant="secondary">未测试</Badge>
  }

  const columns: DataColumn<ModelService>[] = [
    {
      key: "agent",
      header: "Agent",
      render: (s) => s.agentLabel,
      primary: true,
    },
    { key: "provider", header: "服务商", render: (s) => s.providerLabel },
    { key: "name", header: "配置名", render: (s) => s.name, mono: true },
    {
      key: "model",
      header: "默认模型",
      render: (s) => s.model || "—",
      mono: true,
    },
    {
      key: "key",
      header: "Key",
      render: (s) => s.keyTail || "未填写",
      mono: true,
    },
    { key: "status", header: "状态", render: statusOf },
  ]

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="模型服务"
        description="每一项是一套“服务商 + Key”。添加后可以在新建容器、快捷对话里直接选用；已有容器不受影响。"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== ""}
              onClick={() => void openImport()}
            >
              {busy === "import" ? <Spinner data-icon="inline-start" /> : null}
              从本机导入
            </Button>
            <Button
              type="button"
              onClick={() =>
                setDialog({ mode: "create", form: EMPTY_SERVICE_FORM })
              }
            >
              添加模型服务
            </Button>
          </>
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data && data.suggestions.length > 0 ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-2">
            发现可以直接复用的 Key：
            {data.suggestions.map((item) => (
              <div
                key={`${item.from}:${item.agent}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0">{item.label}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy !== ""}
                  onClick={() => void handleReuse(item.from, item.agent)}
                >
                  {busy === `reuse:${item.from}:${item.agent}` ? (
                    <Spinner data-icon="inline-start" />
                  ) : null}
                  一键添加
                </Button>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {fixable.length > 0 ? (
        <Alert variant="warning">
          <AlertDescription className="flex flex-col gap-2">
            这些服务需要附加设置，缺了模型可能调不了工具：
            {fixable.map((service) => (
              <div
                key={service.name}
                className="flex items-center justify-between gap-2"
              >
                <span className="min-w-0">
                  {serviceTitle(service)}（{service.name}）：
                  {Object.keys(service.missingExtraEnv ?? {})
                    .map((key) => envLabel(key) ?? "附加设置")
                    .join("、")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy !== ""}
                  onClick={() => void handleFix(service.name)}
                >
                  一键修复
                </Button>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {failed.length > 0 ? (
        <Alert variant="destructive" role="status">
          <AlertDescription className="flex flex-col gap-2">
            {failed.map((service) => {
              const result = results[service.name]
              return (
                <div key={service.name}>
                  {serviceTitle(service)}（{service.name}）：{result.text}
                  {result.detail ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer">详情</summary>
                      <CodeBlock className="mt-2 max-h-32">
                        {result.detail}
                      </CodeBlock>
                    </details>
                  ) : null}
                </div>
              )
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        label="模型服务"
        columns={columns}
        rows={services}
        loading={!data && !error}
        rowKey={(s) => s.name}
        rowTestId={(s) => `model-service-${s.name}`}
        empty={{
          title: "还没有模型服务",
          description: "添加一套“服务商 + Key”，之后新建容器时直接选用。",
        }}
        actions={(service) => (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="测试"
              title="测试"
              disabled={busy !== ""}
              onClick={() => void handleTest(service.name)}
            >
              <PlayIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="编辑"
              title="编辑"
              disabled={busy !== ""}
              onClick={() => openEdit(service)}
            >
              <PencilIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除"
              title="删除"
              disabled={busy !== ""}
              onClick={() => setDeleting(service)}
            >
              <Trash2Icon />
            </Button>
          </>
        )}
      />

      {importing ? (
        <ImportDialog
          preview={importing}
          onClose={() => setImporting(null)}
          onImported={(next) => {
            applyChange(next)
            setImporting(null)
          }}
        />
      ) : null}

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
            if (next.name && dialog.mode === "create")
              void handleTest(next.name)
          }}
        />
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>删除模型服务</DialogTitle>
            <DialogDescription>
              会删除运行配置“{deleting?.name}
              ”的全部内容（包括你手写在里面的挂载目录等其它设置）。已有容器不受影响，它们创建时已经带上了
              Key。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== ""}
              onClick={() => deleting && void handleDelete(deleting)}
            >
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
  const [sync, setSync] = React.useState(false)
  const agent =
    data.agents.find((item) => item.id === form.agent) ?? data.agents[0]
  const provider =
    agent?.providers.find((item) => item.id === form.providerId) ?? null
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
      onSaved(
        editing && name
          ? await updateModelService(
              name,
              buildEditBody(form, sync && using.length > 0)
            )
          : await createModelService(buildCreateBody(form))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const codexSubscription = subscriptionOnly && form.agent === "codex"

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑模型服务" : "添加模型服务"}</DialogTitle>
          <DialogDescription>
            Key 只保存在本机配置里，页面上只显示末 4 位。
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            {!editing ? (
              <Field>
                <FieldLabel>Agent</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  value={[form.agent]}
                  onValueChange={(values) =>
                    values[0] &&
                    patch({
                      agent: String(values[0]),
                      providerId: "",
                      baseUrl: "",
                      model: "",
                      mode: "key",
                    })
                  }
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
                  value={[form.mode]}
                  disabled={editing}
                  onValueChange={(values) =>
                    values[0] &&
                    patch({
                      mode:
                        values[0] === "subscription" ? "subscription" : "key",
                    })
                  }
                >
                  <ToggleGroupItem value="key">API Key</ToggleGroupItem>
                  <ToggleGroupItem value="subscription">
                    订阅登录
                  </ToggleGroupItem>
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
                <FieldLabel htmlFor="ms-provider">服务商</FieldLabel>
                <Select
                  value={form.providerId || CUSTOM_PROVIDER}
                  onValueChange={(value) => {
                    const item = agent?.providers.find((p) => p.id === value)
                    if (item) {
                      patch({
                        providerId: item.id,
                        baseUrl: item.baseUrl,
                        model: form.model || item.defaultModel,
                      })
                    } else {
                      patch({ providerId: "", baseUrl: "" })
                    }
                  }}
                >
                  <SelectTrigger id="ms-provider" className="w-full">
                    <SelectValue>
                      {(value: string | null) =>
                        agent?.providers.find((p) => p.id === value)?.label ??
                        "自定义地址"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(agent?.providers ?? []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_PROVIDER}>
                        自定义地址
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {provider ? (
                  <FieldDescription>
                    <a href={provider.docUrl} target="_blank" rel="noreferrer">
                      官方说明
                    </a>
                    {provider.extraEnv &&
                    Object.keys(provider.extraEnv).length > 0
                      ? "；已自动带上这家服务需要的附加设置"
                      : ""}
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {!codexSubscription ? (
              <Field>
                <FieldLabel htmlFor="ms-base-url">
                  Base URL
                  {subscriptionOnly ? <Hint>（可选）</Hint> : null}
                </FieldLabel>
                <Input
                  id="ms-base-url"
                  value={form.baseUrl}
                  placeholder="https://…"
                  // 选了服务商就只展示预设的地址（保存时服务端按预设写）；要改地址请选“自定义地址”
                  readOnly={Boolean(provider) && !editing}
                  onChange={(event) => patch({ baseUrl: event.target.value })}
                />
                {subscriptionOnly ? (
                  <FieldDescription>
                    只有转发订阅令牌的网关才需要填。
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {!codexSubscription ? (
              <>
                <Field>
                  <FieldLabel htmlFor="ms-key">
                    {subscriptionOnly ? "订阅令牌" : "API Key"}
                  </FieldLabel>
                  <Input
                    id="ms-key"
                    type="password"
                    autoComplete="off"
                    value={form.key}
                    placeholder={editing ? "留空表示不修改" : ""}
                    onChange={(event) => patch({ key: event.target.value })}
                  />
                  {subscriptionOnly && form.agent === "claude" ? (
                    <FieldDescription>
                      保存后会删掉同一项里的 API Key，否则 Claude Code CLI
                      会优先用 Key，订阅不生效。
                    </FieldDescription>
                  ) : null}
                </Field>
                {!codexSubscription ? (
                  <Field>
                    <FieldLabel htmlFor="ms-model">模型</FieldLabel>
                    <Input
                      id="ms-model"
                      value={form.model}
                      placeholder={
                        provider?.models[0] ||
                        (form.agent === "codex"
                          ? "Codex CLI 接兼容服务必须填写"
                          : "可选")
                      }
                      onChange={(event) => patch({ model: event.target.value })}
                    />
                  </Field>
                ) : null}
                {form.agent === "claude" ? (
                  <SectionToggle title="更多模型设置">
                    <FieldGroup>
                      {CLAUDE_MODEL_FIELDS.map((item) => (
                        <Field key={item.key}>
                          <FieldLabel htmlFor={`ms-${item.key}`}>
                            {item.label}
                            <Hint className="font-mono">{item.key}</Hint>
                          </FieldLabel>
                          <Input
                            id={`ms-${item.key}`}
                            value={form.models[item.key] ?? ""}
                            placeholder="可选"
                            onChange={(event) =>
                              patch({
                                models: {
                                  ...form.models,
                                  [item.key]: event.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                      ))}
                      <Field>
                        <FieldLabel htmlFor="ms-auto-compact">
                          上下文到多大才自动压缩
                          <Hint>（可选）</Hint>
                        </FieldLabel>
                        <Input
                          id="ms-auto-compact"
                          inputMode="numeric"
                          value={form.autoCompactWindow}
                          placeholder={AUTO_COMPACT_HINT}
                          onChange={(event) =>
                            patch({ autoCompactWindow: event.target.value })
                          }
                        />
                        <FieldDescription>
                          填字数（token）；留空表示不设置。模型支持更大的上下文时再填。
                        </FieldDescription>
                      </Field>
                      <FieldDescription>
                        网页聊天里选了模型时，以选的为准。
                      </FieldDescription>
                    </FieldGroup>
                  </SectionToggle>
                ) : null}
                {editing && using.length > 0 ? (
                  <Field orientation="horizontal">
                    <input
                      id="ms-sync"
                      type="checkbox"
                      checked={sync}
                      onChange={(event) => setSync(event.target.checked)}
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <FieldLabel htmlFor="ms-sync">
                        同时更新 {using.length} 个还在用旧设置的容器
                      </FieldLabel>
                      <FieldDescription>
                        下一轮对话生效：{using.join("、")}
                      </FieldDescription>
                    </div>
                  </Field>
                ) : null}
                {!editing ? (
                  <Field>
                    <FieldLabel htmlFor="ms-name">名字</FieldLabel>
                    <Input
                      id="ms-name"
                      value={form.name}
                      placeholder="留空自动生成"
                      onChange={(event) => patch({ name: event.target.value })}
                    />
                    <FieldDescription>
                      也是运行配置的名字，命令行用 manyoyo run -r 名字 启动。
                    </FieldDescription>
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
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          {!codexSubscription ? (
            <Button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner /> : null}
              保存
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 从本机已有的配置里读出 Key / 地址 / 模型，先预览再导入；不挂载本机目录，也不碰登录凭据
function ImportDialog({
  preview,
  onClose,
  onImported,
}: {
  preview: ImportPreview
  onClose: () => void
  onImported: (next: ModelServicesData) => void
}) {
  const importable = preview.candidates.filter((item) => !item.invalid)
  const [picked, setPicked] = React.useState<string[]>(() =>
    importable.filter((item) => !item.duplicate).map((item) => item.id)
  )
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  async function handleImport() {
    setSaving(true)
    setError("")
    try {
      onImported(await importLocalServices(picked))
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>从本机导入</DialogTitle>
          <DialogDescription>
            只读取 Key、地址和模型，不会挂载本机目录，也不会读取登录凭据。
          </DialogDescription>
        </DialogHeader>
        {preview.candidates.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>本机没有找到可导入的 Key</EmptyTitle>
              <EmptyDescription>
                会在这些地方找：
                {preview.sources
                  .map((item) => ` ${item.label}（${item.where}）`)
                  .join("；")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {preview.candidates.map((item) => (
              <label
                key={item.id}
                className="flex items-start gap-2 rounded-lg border p-3"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={Boolean(item.invalid)}
                  checked={picked.includes(item.id)}
                  onChange={(event) =>
                    setPicked((prev) =>
                      event.target.checked
                        ? [...prev, item.id]
                        : prev.filter((id) => id !== item.id)
                    )
                  }
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>
                    {item.agentLabel} · {item.providerLabel}
                  </span>
                  <Hint className="[overflow-wrap:anywhere]">
                    Key {item.keyTail}
                    {item.baseUrl ? ` · ${item.baseUrl}` : ""}
                    {item.model ? ` · 模型 ${item.model}` : ""}
                  </Hint>
                  {item.duplicate ? (
                    <Hint>已经有用同一个 Key 的服务</Hint>
                  ) : null}
                  {item.invalid ? (
                    <Badge variant="destructive" className="w-fit">
                      不能导入：{item.invalid}
                    </Badge>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          {preview.candidates.length > 0 ? (
            <Button
              type="button"
              disabled={saving || picked.length === 0}
              onClick={() => void handleImport()}
            >
              {saving ? <Spinner /> : null}
              导入
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
