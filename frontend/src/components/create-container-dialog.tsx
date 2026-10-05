import * as React from "react"

import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPost } from "@/lib/api"
import { CLI_PROMPT_TEMPLATES, normalizeYolo } from "@/lib/agent-templates"
import { DirectoryPickerDialog } from "@/components/directory-picker-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AutostartEditor } from "@/components/container-manage/autostart-editor"
import { EnvEditor } from "@/components/container-manage/env-editor"
import { NetworkEditor } from "@/components/container-manage/network-editor"
import { defaultPolicy, networkForCreate, type NetworkPolicy } from "@/lib/container-manage"
import { ChevronDownIcon } from "lucide-react"

type CreateContainerForm = {
  run: string
  hostPath: string
  containerName: string
  containerPath: string
  imageName: string
  imageVersion: string
  containerMode: string
  shellPrefix: string
  shell: string
  shellSuffix: string
  yolo: string
  agentPromptCommand: string
  env: string
  envFile: string
  volumes: string
  autostart: string
  autostartOnServe: boolean
  network: NetworkPolicy
}

const DEFAULT_FORM: CreateContainerForm = {
  run: "",
  hostPath: "",
  containerName: "",
  containerPath: "",
  imageName: "",
  imageVersion: "",
  containerMode: "",
  shellPrefix: "",
  shell: "",
  shellSuffix: "",
  yolo: "",
  agentPromptCommand: "",
  env: "",
  envFile: "",
  volumes: "",
  autostart: "",
  autostartOnServe: false,
  network: defaultPolicy(),
}

type RunPreset = {
  yolo?: string
  agentPromptCommand?: string
  [key: string]: unknown
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseEnvText(text: string): Record<string, string> | undefined {
  const entries = parseLines(text)
    .map((line) => {
      const index = line.indexOf("=")
      if (index <= 0) return null
      return [line.slice(0, index).trim(), line.slice(index + 1)] as [string, string]
    })
    .filter((entry): entry is [string, string] => entry !== null)
  return entries.length ? Object.fromEntries(entries) : undefined
}

function buildCreateOptions(form: CreateContainerForm) {
  const options: Record<string, unknown> = {}
  type StringKey = { [K in keyof CreateContainerForm]: CreateContainerForm[K] extends string ? K : never }[keyof CreateContainerForm]
  const stringFields: StringKey[] = [
    "hostPath",
    "containerName",
    "containerPath",
    "imageName",
    "imageVersion",
    "containerMode",
    "shellPrefix",
    "shell",
    "shellSuffix",
    "yolo",
    "agentPromptCommand",
  ]
  for (const key of stringFields) {
    const value = form[key].trim()
    if (value) options[key] = value
  }
  const env = parseEnvText(form.env)
  if (env) options.env = env
  const envFile = parseLines(form.envFile)
  if (envFile.length) options.envFile = envFile
  const volumes = parseLines(form.volumes)
  if (volumes.length) options.volumes = volumes
  if (form.autostart.trim()) options.autostart = form.autostart
  if (form.autostartOnServe) options.autostartOnServe = true
  // 放开类的改动（open）已在编辑器里确认过，这里带上 confirmRisk
  const network = networkForCreate(form.network)
  if (network) {
    options.network = network
    options.confirmRisk = true
  }
  return options
}

export function CreateContainerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (name: string) => void
}) {
  const [form, setForm] = React.useState<CreateContainerForm>(DEFAULT_FORM)
  const [error, setError] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [runs, setRuns] = React.useState<Record<string, RunPreset>>({})
  const [pickerOpen, setPickerOpen] = React.useState(false)

  const loadDefaults = React.useCallback(async () => {
    try {
      const data = await apiGet("/api/config")
      const parsed = (data.parsed || {}) as Record<string, unknown>
      const runsMap =
        parsed.runs && typeof parsed.runs === "object"
          ? (parsed.runs as Record<string, RunPreset>)
          : {}
      setRuns(runsMap)

      const defaults = (data.defaults || {}) as Record<string, unknown>
      setForm({
        ...DEFAULT_FORM,
        hostPath: String(defaults.hostPath || ""),
        containerPath: String(defaults.containerPath || ""),
        imageName: String(defaults.imageName || ""),
        imageVersion: String(defaults.imageVersion || ""),
        containerMode: String(defaults.containerMode || ""),
        shellPrefix: String(defaults.shellPrefix || ""),
        shell: String(defaults.shell || ""),
        shellSuffix: String(defaults.shellSuffix || ""),
        yolo: normalizeYolo(String(defaults.yolo || "")),
        agentPromptCommand: String(defaults.agentPromptCommand || ""),
      })
    } catch {
      setRuns({})
      setForm(DEFAULT_FORM)
    }
  }, [])

  // 渲染期间对比 open 变化来重置错误提示，而不是在 effect 里同步 setState；
  // effect 只保留真正的异步拉取（loadDefaults 内部的 setState 都在 await 之后触发）
  const [prevOpen, setPrevOpen] = React.useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setError("")
  }

  React.useEffect(() => {
    if (!open) return
    queueMicrotask(() => loadDefaults())
  }, [open, loadDefaults])

  function setField<K extends keyof CreateContainerForm>(
    key: K,
    value: CreateContainerForm[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleRunChange(value: string | null) {
    const runName = value ?? ""
    const preset = runName ? runs[runName] : undefined
    const normalizedYolo = preset?.yolo ? normalizeYolo(String(preset.yolo)) : ""
    const agentPromptCommand = preset?.agentPromptCommand
      ? String(preset.agentPromptCommand)
      : normalizedYolo
        ? CLI_PROMPT_TEMPLATES[normalizedYolo]
        : undefined
    setForm((prev) => ({
      ...prev,
      run: runName,
      ...(normalizedYolo ? { yolo: normalizedYolo } : {}),
      ...(agentPromptCommand ? { agentPromptCommand } : {}),
    }))
  }

  function handleCliChange(value: string | null) {
    const cli = value ?? ""
    setForm((prev) => ({
      ...prev,
      yolo: cli,
      agentPromptCommand: CLI_PROMPT_TEMPLATES[cli] || prev.agentPromptCommand,
    }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    if (!form.hostPath.trim() && !form.run) {
      setError("hostPath 不能为空")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      const createOptions = buildCreateOptions(form)
      const body: Record<string, unknown> = {}
      if (form.run) body.run = form.run
      if (Object.keys(createOptions).length) body.createOptions = createOptions
      const data = await apiPost("/api/sessions", body)
      onOpenChange(false)
      onCreated(String(data.name))
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] flex-col sm:max-w-lg lg:max-w-2xl",
          // 目录选择弹窗嵌套打开时，base-ui 的 Dialog 会复用外层已有的遮罩层，
          // 不会再单独给这层弹窗加虚化，这里手动虚化+禁用交互，避免误点到背后的表单
          pickerOpen && "pointer-events-none opacity-40 blur-[2px]"
        )}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>新建容器会话</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
            <FieldGroup className="gap-4">
              <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="create-run">run</FieldLabel>
                  <Select value={form.run} onValueChange={handleRunChange}>
                    <SelectTrigger id="create-run" className="w-full">
                      <SelectValue placeholder="(不使用 run)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.keys(runs).map((run) => (
                          <SelectItem key={run} value={run}>
                            {run}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-container-name">
                    containerName
                  </FieldLabel>
                  <Input
                    id="create-container-name"
                    placeholder="my-dev 或 my-{now}"
                    value={form.containerName}
                    onChange={(event) =>
                      setField("containerName", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="create-host-path">hostPath</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id="create-host-path"
                      placeholder="/abs/path/project"
                      value={form.hostPath}
                      onChange={(event) =>
                        setField("hostPath", event.target.value)
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPickerOpen(true)}
                    >
                      选择
                    </Button>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-container-path">
                    containerPath
                  </FieldLabel>
                  <Input
                    id="create-container-path"
                    placeholder="/workspace"
                    value={form.containerPath}
                    onChange={(event) =>
                      setField("containerPath", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="create-image-name">imageName</FieldLabel>
                  <Input
                    id="create-image-name"
                    placeholder="ghcr.io/xcanwin/manyoyo"
                    value={form.imageName}
                    onChange={(event) =>
                      setField("imageName", event.target.value)
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-image-version">
                    imageVersion
                  </FieldLabel>
                  <Input
                    id="create-image-version"
                    placeholder="1.9.1-common"
                    value={form.imageVersion}
                    onChange={(event) =>
                      setField("imageVersion", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="create-container-mode">
                    containerMode
                  </FieldLabel>
                  <Select
                    value={form.containerMode}
                    onValueChange={(value: string | null) =>
                      setField("containerMode", value ?? "")
                    }
                  >
                    <SelectTrigger id="create-container-mode" className="w-full">
                      <SelectValue placeholder="(跟随默认)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="common">common</SelectItem>
                        <SelectItem value="dind">dind</SelectItem>
                        <SelectItem value="sock">sock</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-shell-prefix">
                    shellPrefix
                  </FieldLabel>
                  <Input
                    id="create-shell-prefix"
                    placeholder="例如 IS_SANDBOX=1"
                    value={form.shellPrefix}
                    onChange={(event) =>
                      setField("shellPrefix", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="create-shell">shell</FieldLabel>
                  <Input
                    id="create-shell"
                    placeholder="例如 claude / codex"
                    value={form.shell}
                    onChange={(event) => setField("shell", event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-shell-suffix">
                    shellSuffix
                  </FieldLabel>
                  <Input
                    id="create-shell-suffix"
                    placeholder="例如 --dangerously-skip-permissions"
                    value={form.shellSuffix}
                    onChange={(event) =>
                      setField("shellSuffix", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel htmlFor="create-yolo">CLI</FieldLabel>
                  <Select value={form.yolo} onValueChange={handleCliChange}>
                    <SelectTrigger id="create-yolo" className="w-full">
                      <SelectValue placeholder="(不使用)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="claude">claude</SelectItem>
                        <SelectItem value="codex">codex</SelectItem>
                        <SelectItem value="gemini">gemini</SelectItem>
                        <SelectItem value="opencode">opencode</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="create-agent-prompt-command">
                    agentPromptCommand
                  </FieldLabel>
                  <Input
                    id="create-agent-prompt-command"
                    placeholder="例如 codex exec --plain-text {prompt}"
                    value={form.agentPromptCommand}
                    onChange={(event) =>
                      setField("agentPromptCommand", event.target.value)
                    }
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel>环境变量</FieldLabel>
                <EnvEditor
                  idPrefix="create"
                  value={form.env}
                  onChange={(text) => setField("env", text)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="create-env-file">
                  envFile (绝对路径，每行一项)
                </FieldLabel>
                <Textarea
                  id="create-env-file"
                  placeholder="/abs/path/.env"
                  className="min-h-16"
                  value={form.envFile}
                  onChange={(event) => setField("envFile", event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="create-volumes">
                  volumes (每行一项)
                </FieldLabel>
                <Textarea
                  id="create-volumes"
                  placeholder="/host/path:/container/path"
                  className="min-h-16"
                  value={form.volumes}
                  onChange={(event) => setField("volumes", event.target.value)}
                />
              </Field>

              <Collapsible className="rounded-lg border">
                <CollapsibleTrigger
                  render={<Button type="button" variant="ghost" className="w-full justify-between" />}
                >
                  自启动命令
                  <ChevronDownIcon data-icon="inline-end" />
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pt-1 pb-3">
                  <AutostartEditor
                    idPrefix="create"
                    script={form.autostart}
                    onScriptChange={(value) => setField("autostart", value)}
                    onServe={form.autostartOnServe}
                    onServeChange={(value) => setField("autostartOnServe", value)}
                  />
                </CollapsibleContent>
              </Collapsible>

              <Collapsible className="rounded-lg border">
                <CollapsibleTrigger
                  render={<Button type="button" variant="ghost" className="w-full justify-between" />}
                >
                  网络（默认收紧）
                  <ChevronDownIcon data-icon="inline-end" />
                </CollapsibleTrigger>
                <CollapsibleContent className="px-3 pt-1 pb-3">
                  <NetworkEditor
                    idPrefix="create"
                    policy={form.network}
                    onChange={(value) => setField("network", value)}
                    peers={[]}
                    showPeers={false}
                  />
                </CollapsibleContent>
              </Collapsible>

              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </div>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => loadDefaults()}
              disabled={submitting}
            >
              重置默认
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "创建中..." : "创建并进入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={form.hostPath}
        onSelect={(path) => setForm((prev) => ({ ...prev, hostPath: path, containerPath: path }))}
      />
    </Dialog>
  )
}
