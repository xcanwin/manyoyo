import * as React from "react"

import { useAgentAvailability } from "@/hooks/use-agent-availability"
import { AGENT_UNAVAILABLE_HINT } from "@/lib/setup"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup } from "@/components/ui/field"
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
import { Hint } from "@/components/hint"
import { fetchModelServices, runLabel, runLabelMap } from "@/lib/model-services"
import { apiGet, apiPost } from "@/lib/api"
import { expandTemplate, formatNow } from "@/lib/name-template"
import { CLI_PROMPT_TEMPLATES, normalizeYolo } from "@/lib/agent-templates"
import { DirectoryPickerDialog } from "@/components/directory-picker-dialog"
import { AutostartEditor } from "@/components/container-manage/autostart-editor"
import { SystemPromptEditor } from "@/components/container-manage/system-prompt-editor"
import { EnvEditor } from "@/components/container-manage/env-editor"
import { NetworkEditor } from "@/components/container-manage/network-editor"
import {
  cleanPolicy,
  defaultPolicy,
  networkForCreate,
  parseEnvText,
  policyProblems,
  policyRisks,
  PRESET_LABELS,
  type NetworkPolicy,
} from "@/lib/container-manage"
import {
  mergeSelectedCandidates,
  type EndpointCandidate,
  type InferResponse,
  type NewContainerPreset,
} from "@/lib/network-infer"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"

import { KeyLabel } from "@/components/key-label"
import { SectionToggle } from "@/components/section-toggle"
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
  envFiles: string[]
  volumes: string
  autostart: string
  autostartOnServe: boolean
  systemPrompt: string
  systemPromptDefault: string
  systemPromptEnabled: boolean
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
  envFiles: [],
  volumes: "",
  autostart: "",
  autostartOnServe: false,
  systemPrompt: "",
  systemPromptDefault: "",
  systemPromptEnabled: true,
  network: defaultPolicy(),
}

type RunPreset = {
  yolo?: string
  agentPromptCommand?: string
  [key: string]: unknown
}

const SOURCE_LABELS: Record<EndpointCandidate["sources"][number], string> = {
  autostart: "自启动",
  first: "首次命令",
  "first.env": "首次环境变量",
  "first.envFile": "首次环境变量文件",
}

const RISK_LABELS: Record<Exclude<EndpointCandidate["risk"], "">, string> = {
  private: "内网",
  metadata: "云元数据",
  wide: "范围很大",
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseEnvForm(text: string): Record<string, string> | undefined {
  const { entries } = parseEnvText(text)
  return entries.length
    ? Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
    : undefined
}

function hasNetworkContent(policy: NetworkPolicy): boolean {
  return networkForCreate(policy) !== undefined || policy.auditHttp === true
}

const ruleKey = (target: string, ports: string, proto: string) =>
  `allow|${target}|${ports}|${proto}`

function hasSameAllowRule(policy: NetworkPolicy, candidate: EndpointCandidate): boolean {
  const existing = new Set(
    policy.outbound
      .filter((rule) => rule.action === "allow")
      .map((rule) => ruleKey((rule.target ?? "").trim().toLowerCase(), rule.ports, rule.proto))
  )
  return existing.has(ruleKey(candidate.target.toLowerCase(), candidate.ports, candidate.proto))
}

function coversDeniedRule(policy: NetworkPolicy, candidate: EndpointCandidate): boolean {
  return policy.outbound.some(
    (rule) =>
      rule.enabled &&
      rule.action === "deny" &&
      (rule.target ?? "").trim().toLowerCase() === candidate.target.toLowerCase()
  )
}

function buildCreateOptions(
  form: CreateContainerForm,
  preset: NewContainerPreset | null,
  mergedNetwork: NetworkPolicy
) {
  const options: Record<string, unknown> = {}
  type StringKey = {
    [K in keyof CreateContainerForm]: CreateContainerForm[K] extends string
      ? K
      : never
  }[keyof CreateContainerForm]
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
  const env = parseEnvForm(form.env)
  if (env) options.env = env
  const envFile = form.envFiles.map((file) => file.trim()).filter(Boolean)
  if (envFile.length) options.envFile = envFile
  const volumes = parseLines(form.volumes)
  if (volumes.length) options.volumes = volumes
  // 只有相对预设（没有预设时是空值）改过才发送；空串 / false 也是合法的显式覆盖
  if (form.autostart !== (preset?.autostart ?? "")) options.autostart = form.autostart
  if (form.autostartOnServe !== (preset?.autostartOnServe ?? false)) {
    options.autostartOnServe = form.autostartOnServe
  }
  // 没改过内容就不带，由服务端按所选运行配置算默认值
  if (
    !form.systemPromptEnabled ||
    form.systemPrompt !== form.systemPromptDefault
  ) {
    options.systemPrompt = {
      enabled: form.systemPromptEnabled,
      text: form.systemPrompt,
    }
  }
  // 与预设不同才发（包括把预设改回默认）；放开类的改动已在编辑器 / 这里确认过，带上 confirmRisk
  const network = networkForCreate(mergedNetwork, preset?.network ?? defaultPolicy())
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
  // 运行配置的友好名字（模型服务识别出来的才有）
  const [runLabels, setRunLabels] = React.useState<Record<string, string>>({})
  const [pickerOpen, setPickerOpen] = React.useState(false)
  // 默认建议的工作目录（工作目录根/时间戳，和快捷对话一样）：只是预填，点“创建”时才真的建目录
  const [suggestedDir, setSuggestedDir] = React.useState("")
  const [suggestedContainerPath, setSuggestedContainerPath] = React.useState("")
  // 服务端返回的预设（“没有请求覆盖时的有效配置”）：表单以它为基线，只发送改过的字段
  const [preset, setPreset] = React.useState<NewContainerPreset | null>(null)
  const [presetLoading, setPresetLoading] = React.useState(false)
  const [presetError, setPresetError] = React.useState("")
  const [presetVersion, setPresetVersion] = React.useState(0)
  // 自动展开：初始 / 切换运行配置时按预设内容展开；之后尊重用户的手动开合
  const [expansion, setExpansion] = React.useState({ autostart: false, network: false })
  // 地址识别候选（只是建议，用户勾选后才加入白名单）
  const [candidates, setCandidates] = React.useState<EndpointCandidate[]>([])
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [inferLoading, setInferLoading] = React.useState(false)
  const [inferError, setInferError] = React.useState("")
  const [inferTruncated, setInferTruncated] = React.useState(false)
  const candidatesRef = React.useRef<HTMLDivElement>(null)
  const selectedRef = React.useRef<Set<string>>(new Set())
  const seenCandidateIdsRef = React.useRef<Set<string>>(new Set())
  const candidatesAutoExpandedRef = React.useRef(false)
  const inferTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const inferSeqRef = React.useRef(0)
  const presetSeqRef = React.useRef(0)
  const loadSeqRef = React.useRef(0)
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const isAgentAvailable = useAgentAvailability(open)

  function applySelected(next: Set<string>) {
    selectedRef.current = next
    setSelectedIds(next)
  }

  function resetCandidates() {
    seenCandidateIdsRef.current = new Set()
    applySelected(new Set())
    setCandidates([])
    setInferTruncated(false)
    setInferError("")
  }

  function applyInfer(data: InferResponse) {
    const seen = seenCandidateIdsRef.current
    const next = new Set<string>()
    for (const candidate of data.candidates) {
      if (selectedRef.current.has(candidate.id)) next.add(candidate.id)
      else if (!seen.has(candidate.id) && candidate.defaultChecked) next.add(candidate.id)
    }
    data.candidates.forEach((candidate) => seen.add(candidate.id))
    applySelected(next)
    setCandidates(data.candidates)
    setInferTruncated(Boolean(data.truncated))
    if (data.candidates.length && !candidatesAutoExpandedRef.current) {
      candidatesAutoExpandedRef.current = true
      setExpansion((prev) => (prev.network ? prev : { ...prev, network: true }))
    }
  }

  function scheduleInfer(
    autostart: string | undefined,
    runName: string,
    networkPreset: NetworkPolicy["preset"],
    delay: number
  ) {
    if (inferTimerRef.current) clearTimeout(inferTimerRef.current)
    const seq = ++inferSeqRef.current
    const fire = async () => {
      setInferLoading(true)
      setInferError("")
      try {
        const body: Record<string, unknown> = { preset: networkPreset }
        if (runName) body.run = runName
        if (autostart !== undefined) body.autostart = autostart
        const data = (await apiPost(
          "/api/system/new-container-preset/infer",
          body
        )) as InferResponse
        if (seq !== inferSeqRef.current) return
        applyInfer(data)
      } catch (err) {
        if (seq !== inferSeqRef.current) return
        setInferError(err instanceof Error ? err.message : "地址识别失败")
      } finally {
        if (seq === inferSeqRef.current) setInferLoading(false)
      }
    }
    inferTimerRef.current = setTimeout(fire, delay)
  }

  function applyPreset(value: NewContainerPreset) {
    setPreset(value)
    setPresetVersion((version) => version + 1)
    setForm((prev) => ({
      ...prev,
      autostart: value.autostart,
      autostartOnServe: value.autostartOnServe,
      network: value.network,
    }))
    resetCandidates()
    candidatesAutoExpandedRef.current = false
    setExpansion({
      autostart: Boolean(value.autostart.trim() || value.autostartOnServe),
      network: hasNetworkContent(value.network),
    })
    scheduleInfer(value.autostart, value.run || "", value.network.preset, 0)
  }

  async function loadPreset(runName: string) {
    const seq = ++presetSeqRef.current
    setPresetLoading(true)
    setPresetError("")
    try {
      const value = (await apiGet(
        `/api/system/new-container-preset${runName ? `?run=${encodeURIComponent(runName)}` : ""}`
      )) as NewContainerPreset
      if (seq !== presetSeqRef.current) return
      applyPreset(value)
    } catch (err) {
      if (seq !== presetSeqRef.current) return
      // 不静默按默认值回填：保留当前表单，显示错误；用户清空运行配置后按全局预设重试
      setPreset(null)
      setPresetError(err instanceof Error ? err.message : "读取运行配置的预设失败")
    } finally {
      if (seq === presetSeqRef.current) setPresetLoading(false)
    }
  }

  const loadDefaults = React.useCallback(async () => {
    const seq = ++loadSeqRef.current
    setPresetLoading(true)
    setPresetError("")
    try {
      const data = await apiGet("/api/config")
      const parsed = (data.parsed || {}) as Record<string, unknown>
      const runsMap =
        parsed.runs && typeof parsed.runs === "object"
          ? (parsed.runs as Record<string, RunPreset>)
          : {}
      setRuns(runsMap)
      fetchModelServices()
        .then((result) => setRunLabels(runLabelMap(result.services)))
        .catch(() => setRunLabels({}))

      const defaults = (data.defaults || {}) as Record<string, unknown>
      // 系统提示词的初始内容 = 系统设置里的默认 + 补充（各自开关生效）
      const composed = await apiGet("/api/agent-instructions")
        .then((info) => String(info.composed || ""))
        .catch(() => "")
      // 默认值是模板（配置里写了就用配置的）：容器名 my-easy-{now}，宿主机目录与容器内目录 {quickChatPath}/{now}。
      // 这里展开成具体值显示，同一次打开共用一个时间；目录在点“创建”时才建
      const suggestion = await apiGet("/api/system/new-container-defaults")
        .then((info) => {
          const vars = {
            now: formatNow(),
            quickChatPath: String(info.quickChatPath || ""),
          }
          const name = expandTemplate(
            String(info.containerName || ""),
            vars
          ).value
          const host = expandTemplate(String(info.hostPath || ""), vars)
          const container = expandTemplate(
            String(info.containerPath || ""),
            vars
          ).value
          return {
            name,
            host: host.value,
            container,
            createHost: host.templated,
          }
        })
        .catch(() => null)
      // 全局预设（没选运行配置时）：拉取失败只提示，不阻塞其余默认值
      let presetFailure = ""
      const presetValue = await apiGet("/api/system/new-container-preset").catch(
        (err: unknown) => {
          presetFailure = err instanceof Error ? err.message : "读取预设失败"
          return null
        }
      )
      if (seq !== loadSeqRef.current) return
      const baseline = presetValue && typeof presetValue === "object"
        ? (presetValue as NewContainerPreset)
        : null
      setPreset(baseline)
      setPresetVersion((version) => version + 1)
      setPresetError(baseline ? "" : presetFailure)
      resetCandidates()
      candidatesAutoExpandedRef.current = false
      setExpansion({
        autostart: Boolean(baseline && (baseline.autostart.trim() || baseline.autostartOnServe)),
        network: Boolean(baseline && hasNetworkContent(baseline.network)),
      })
      setSuggestedDir(suggestion?.createHost ? suggestion.host : "")
      setSuggestedContainerPath(suggestion?.container ?? "")
      setForm({
        ...DEFAULT_FORM,
        hostPath: suggestion
          ? suggestion.host
          : String(defaults.hostPath || ""),
        containerPath: suggestion
          ? suggestion.container
          : String(defaults.containerPath || ""),
        containerName: suggestion?.name ?? "",
        imageName: String(defaults.imageName || ""),
        imageVersion: String(defaults.imageVersion || ""),
        containerMode: String(defaults.containerMode || ""),
        shellPrefix: String(defaults.shellPrefix || ""),
        shell: String(defaults.shell || ""),
        shellSuffix: String(defaults.shellSuffix || ""),
        yolo: normalizeYolo(String(defaults.yolo || "")),
        agentPromptCommand: String(defaults.agentPromptCommand || ""),
        systemPrompt: composed,
        systemPromptDefault: composed,
        ...(baseline
          ? {
              autostart: baseline.autostart,
              autostartOnServe: baseline.autostartOnServe,
              network: baseline.network,
            }
          : {}),
      })
      if (baseline) {
        scheduleInfer(baseline.autostart, baseline.run || "", baseline.network.preset, 0)
      }
    } catch {
      if (seq !== loadSeqRef.current) return
      setRuns({})
      setPreset(null)
      resetCandidates()
      setForm(DEFAULT_FORM)
    } finally {
      if (seq === loadSeqRef.current) setPresetLoading(false)
    }
    // 预设 / 推断只在打开时和用户操作时触发；这里引用到的都是稳定的 setState 与模块函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  React.useEffect(
    () => () => {
      if (inferTimerRef.current) clearTimeout(inferTimerRef.current)
    },
    []
  )

  // 选了自带目录的运行配置时目录框留空（交给运行配置），提示里写出它用的是哪个目录，不能是一片空白
  const runPreset = form.run ? runs[form.run] : undefined
  const runHostPath = typeof runPreset?.hostPath === "string" ? runPreset.hostPath.trim() : ""
  const runContainerPath = typeof runPreset?.containerPath === "string" && runPreset.containerPath.trim() ? runPreset.containerPath.trim() : runHostPath

  function setField<K extends keyof CreateContainerForm>(
    key: K,
    value: CreateContainerForm[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleRunChange(value: string | null) {
    const runName = value ?? ""
    const preset = runName ? runs[runName] : undefined
    const normalizedYolo = preset?.yolo
      ? normalizeYolo(String(preset.yolo))
      : ""
    const agentPromptCommand = preset?.agentPromptCommand
      ? String(preset.agentPromptCommand)
      : normalizedYolo
        ? CLI_PROMPT_TEMPLATES[normalizedYolo]
        : undefined
    setForm((prev) => {
      // 运行配置自己写了 hostPath：把目录留空，让服务端按运行配置走（请求里的值会盖过运行配置，
      // 且运行配置里的路径可能带 ~，不能原样回填）；换成没写 hostPath 的运行配置或取消选择，再恢复预填的目录
      const presetHasHost =
        typeof preset?.hostPath === "string" && preset.hostPath.trim() !== ""
      let hostFields: Partial<CreateContainerForm> = {}
      if (presetHasHost) {
        hostFields = { hostPath: "", containerPath: "" }
      } else if (suggestedDir && !prev.hostPath.trim()) {
        hostFields = {
          hostPath: suggestedDir,
          containerPath: suggestedContainerPath,
        }
      }
      return {
        ...prev,
        ...hostFields,
        run: runName,
        ...(normalizedYolo ? { yolo: normalizedYolo } : {}),
        ...(agentPromptCommand ? { agentPromptCommand } : {}),
      }
    })
    void loadPreset(runName)
  }

  function handleCliChange(value: string | null) {
    const cli = value ?? ""
    setForm((prev) => ({
      ...prev,
      yolo: cli,
      agentPromptCommand: CLI_PROMPT_TEMPLATES[cli] || prev.agentPromptCommand,
    }))
  }

  function handleAutostartChange(value: string) {
    setField("autostart", value)
    scheduleInfer(value, form.run, form.network.preset, 800)
  }

  function handleNetworkChange(value: NetworkPolicy) {
    const presetChanged = value.preset !== form.network.preset
    setField("network", value)
    if (presetChanged) {
      // 旧模式的候选不能合并到新模式
      resetCandidates()
      scheduleInfer(form.autostart, form.run, value.preset, 0)
    }
  }

  function toggleCandidate(id: string, checked: boolean) {
    const next = new Set(selectedRef.current)
    if (checked) next.add(id)
    else next.delete(id)
    applySelected(next)
  }

  function revealCandidates() {
    setExpansion((prev) => ({ ...prev, network: true }))
    requestAnimationFrame(() => candidatesRef.current?.scrollIntoView({ block: "nearest" }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    if (presetLoading) {
      setError("正在读取运行配置的预设，请稍候")
      return
    }
    if (presetError) {
      setError(presetError)
      return
    }
    if (!form.hostPath.trim() && !form.run) {
      setError("hostPath 不能为空")
      return
    }
    if (policyProblems(form.network).length) {
      setError("网络规则里有写法不对的地方，请先改正")
      return
    }
    const mergedNetwork = mergeSelectedCandidates(form.network, candidates, selectedIds)
    // 放开类的改动（自定义模式已在编辑器里确认过）：范围很大的出站规则、绑定 0.0.0.0 的端口暴露在这里确认；
    // 预设里本来就有的宽规则不再重复问
    const risks = policyRisks(preset?.network ?? defaultPolicy(), cleanPolicy(mergedNetwork))
    if (
      risks.includes("wide") &&
      !(await confirm({
        title: "放开范围很大的规则？",
        message:
          "新增的允许规则覆盖范围很大（任何地址、内网、云元数据、整个 /8 以上的网段，或类似 *.co.uk 的公共后缀通配），可能让容器越过原有的网络限制。",
        confirmLabel: "确认放开",
      }))
    )
      return
    if (
      risks.includes("publicBind") &&
      !(await confirm({
        title: "让局域网 / 公网可见？",
        message:
          "端口暴露绑定了 0.0.0.0：能访问到这台机器的任何设备（局域网，服务器在公网时是整个互联网）都可以访问这个宿主机端口，并直达容器里的服务。请确认防火墙已按需限制来源。",
        confirmLabel: "确认暴露",
      }))
    )
      return
    setSubmitting(true)
    setError("")
    try {
      const createOptions = buildCreateOptions(form, preset, mergedNetwork)
      // 预填的目录还没建：此刻才建（用户改成别的路径就不动，那个路径本来就得存在）
      if (suggestedDir && form.hostPath.trim() === suggestedDir) {
        const made = await apiPost("/api/fs/directories/mkdir", {
          path: suggestedDir,
        })
        const dir =
          typeof made.path === "string" && made.path ? made.path : suggestedDir
        createOptions.hostPath = dir
        if (form.containerPath.trim() === suggestedDir)
          createOptions.containerPath = dir
      }
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

  const presetFromRun = Boolean(preset && preset.run)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>新建容器会话</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          <DialogBody>
            <FieldGroup>
              {candidates.length ? (
                <Alert>
                  <AlertDescription>
                    检测到 {candidates.length} 个可能需要放行的地址（来自自启动 /
                    首次命令），已在下方「网络」里列出。
                  </AlertDescription>
                  <AlertAction>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={revealCandidates}
                    >
                      查看并选择
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}

              <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
                <Field>
                  <KeyLabel htmlFor="create-run" k="run" />
                  <Select value={form.run} onValueChange={handleRunChange}>
                    <SelectTrigger id="create-run" className="w-full">
                      <SelectValue placeholder="(不使用 run)">
                        {(value: string | null) =>
                          value ? runLabel(value, runLabels) : "(不使用 run)"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.keys(runs).map((run) => (
                          <SelectItem key={run} value={run}>
                            {runLabel(run, runLabels)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {presetError ? (
                    <Hint className="block text-destructive">{presetError}</Hint>
                  ) : null}
                </Field>
                <Field>
                  <KeyLabel htmlFor="create-container-name" k="containerName" />
                  <Input
                    id="create-container-name"
                    placeholder="例如 my-dev 或 my-{now}"
                    value={form.containerName}
                    onChange={(event) =>
                      setField("containerName", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <KeyLabel htmlFor="create-host-path" k="hostPath" />
                  <div className="flex gap-2">
                    <Input
                      id="create-host-path"
                      placeholder={runHostPath ? `留空就用运行配置里的目录：${runHostPath}` : "例如 /path/to/project"}
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
                  <KeyLabel htmlFor="create-container-path" k="containerPath" />
                  <Input
                    id="create-container-path"
                    placeholder={runContainerPath ? `留空就用运行配置里的目录：${runContainerPath}` : "例如 /workspace"}
                    value={form.containerPath}
                    onChange={(event) =>
                      setField("containerPath", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <KeyLabel htmlFor="create-image-name" k="imageName" />
                  <Input
                    id="create-image-name"
                    placeholder="例如 ghcr.io/xcanwin/manyoyo"
                    value={form.imageName}
                    onChange={(event) =>
                      setField("imageName", event.target.value)
                    }
                  />
                </Field>
                <Field>
                  <KeyLabel htmlFor="create-image-version" k="imageVersion" />
                  <Input
                    id="create-image-version"
                    placeholder="例如 2.3.0-common"
                    value={form.imageVersion}
                    onChange={(event) =>
                      setField("imageVersion", event.target.value)
                    }
                  />
                </Field>

                <Field>
                  <KeyLabel htmlFor="create-container-mode" k="containerMode" />
                  <Select
                    value={form.containerMode}
                    onValueChange={(value: string | null) =>
                      setField("containerMode", value ?? "")
                    }
                  >
                    <SelectTrigger
                      id="create-container-mode"
                      className="w-full"
                    >
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
                  <KeyLabel htmlFor="create-shell-prefix" k="shellPrefix" />
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
                  <KeyLabel htmlFor="create-shell" k="shell" />
                  <Input
                    id="create-shell"
                    placeholder="例如 claude / codex"
                    value={form.shell}
                    onChange={(event) => setField("shell", event.target.value)}
                  />
                </Field>
                <Field>
                  <KeyLabel htmlFor="create-shell-suffix" k="shellSuffix" />
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
                  <KeyLabel htmlFor="create-yolo" k="yolo" />
                  <Select value={form.yolo} onValueChange={handleCliChange}>
                    <SelectTrigger id="create-yolo" className="w-full">
                      <SelectValue placeholder="(不使用)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {["claude", "codex", "gemini", "opencode"].map((id) => (
                          <SelectItem
                            key={id}
                            value={id}
                            disabled={!isAgentAvailable(id)}
                          >
                            {isAgentAvailable(id)
                              ? id
                              : `${id}（${AGENT_UNAVAILABLE_HINT}）`}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <KeyLabel
                    htmlFor="create-agent-prompt-command"
                    k="agentPromptCommand"
                  />
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
                <KeyLabel
                  htmlFor="create-volumes"
                  k="volumes"
                  hint="每行一项"
                />
                <Textarea
                  id="create-volumes"
                  placeholder="例如 /path/to/data:/data"
                  className="min-h-16"
                  value={form.volumes}
                  onChange={(event) => setField("volumes", event.target.value)}
                />
              </Field>

              <SectionToggle title="环境变量（含环境变量文件）">
                <EnvEditor
                  idPrefix="create"
                  value={form.env}
                  onChange={(text) => setField("env", text)}
                  files={form.envFiles}
                  onFilesChange={(files) => setField("envFiles", files)}
                />
              </SectionToggle>

              <SectionToggle
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    网络（默认收紧，含端口暴露）
                    {presetFromRun ? <Badge variant="secondary">运行配置带入</Badge> : null}
                    <Badge variant="outline">{PRESET_LABELS[form.network.preset]}</Badge>
                  </span>
                }
                open={expansion.network}
                onOpenChange={(value) =>
                  setExpansion((prev) => ({ ...prev, network: value }))
                }
              >
                <div className="flex flex-col gap-4">
                  {candidates.length || inferLoading || inferError ? (
                    <div
                      ref={candidatesRef}
                      className="flex flex-col gap-2 rounded-lg border p-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle>检测到可能需要放行的地址</CardTitle>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            scheduleInfer(
                              form.autostart,
                              form.run,
                              form.network.preset,
                              0
                            )
                          }
                          disabled={inferLoading}
                        >
                          {inferLoading ? "识别中..." : "重新识别"}
                        </Button>
                      </div>
                      <Hint>
                        来自自启动 / 首次命令，勾选后加入出站允许规则；只是建议，不勾选就不会添加。
                      </Hint>
                      {inferError ? (
                        <Alert variant="destructive">
                          <AlertDescription>{inferError}</AlertDescription>
                        </Alert>
                      ) : null}
                      {inferLoading ? (
                        <div className="flex items-center gap-2">
                          <Spinner />
                          <Hint>正在识别…</Hint>
                        </div>
                      ) : null}
                      <div className="flex flex-col gap-2">
                        {candidates.map((candidate) => {
                          const already = hasSameAllowRule(form.network, candidate)
                          return (
                            <label
                              key={candidate.id}
                              className="flex cursor-pointer items-start gap-2 rounded-md border p-2 hover:bg-muted/70"
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={selectedIds.has(candidate.id)}
                                onCheckedChange={(checked) =>
                                  toggleCandidate(candidate.id, Boolean(checked))
                                }
                              />
                              <span className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="truncate font-mono">
                                    {candidate.target}
                                  </span>
                                  <Hint mono>
                                    {candidate.ports
                                      ? `端口 ${candidate.ports}`
                                      : "不限端口"}
                                  </Hint>
                                  {candidate.risk ? (
                                    <Badge
                                      variant={
                                        candidate.risk === "metadata"
                                          ? "destructive"
                                          : "warning"
                                      }
                                    >
                                      {RISK_LABELS[candidate.risk]}
                                    </Badge>
                                  ) : null}
                                  {already ? (
                                    <Badge variant="secondary">已有规则</Badge>
                                  ) : null}
                                  {coversDeniedRule(form.network, candidate) ? (
                                    <Badge variant="warning">将覆盖拒绝规则</Badge>
                                  ) : null}
                                </span>
                                <Hint className="truncate">
                                  来源：
                                  {candidate.sources
                                    .map((source) => SOURCE_LABELS[source])
                                    .join(" / ")}
                                  {" · "}
                                  <span className="font-mono">{candidate.evidence}</span>
                                </Hint>
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      {inferTruncated ? (
                        <Hint>只显示前 50 条，其余请手动添加。</Hint>
                      ) : null}
                    </div>
                  ) : null}
                  <NetworkEditor
                    key={`${form.run}:${presetVersion}`}
                    policy={form.network}
                    onChange={handleNetworkChange}
                    showAccess={false}
                  />
                </div>
              </SectionToggle>

              <SectionToggle
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    自启动命令
                    {preset && preset.run && (preset.autostart.trim() || preset.autostartOnServe) ? (
                      <Badge variant="secondary">运行配置带入</Badge>
                    ) : null}
                  </span>
                }
                open={expansion.autostart}
                onOpenChange={(value) =>
                  setExpansion((prev) => ({ ...prev, autostart: value }))
                }
              >
                <AutostartEditor
                  idPrefix="create"
                  script={form.autostart}
                  onScriptChange={handleAutostartChange}
                  onServe={form.autostartOnServe}
                  onServeChange={(value) => setField("autostartOnServe", value)}
                />
              </SectionToggle>

              <SectionToggle title="系统提示词">
                <SystemPromptEditor
                  idPrefix="create"
                  text={form.systemPrompt}
                  onTextChange={(value) => setField("systemPrompt", value)}
                  enabled={form.systemPromptEnabled}
                  onEnabledChange={(value) =>
                    setField("systemPromptEnabled", value)
                  }
                />
              </SectionToggle>
            </FieldGroup>
          </DialogBody>

          {/* 错误放在滚动区外、按钮上方：表单很长时放在最底下用户根本看不到 */}
          {error ? (
            <Alert variant="destructive" className="shrink-0" role="alert">
              <AlertDescription className="break-words">
                {error}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => loadDefaults()}
              disabled={submitting}
            >
              重置默认
            </Button>
            <Button
              type="submit"
              disabled={submitting || presetLoading || Boolean(presetError)}
            >
              {submitting ? "创建中..." : presetLoading ? "读取预设中..." : "创建并进入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      {confirmDialog}
      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={form.hostPath}
        onSelect={(path) =>
          setForm((prev) => ({ ...prev, hostPath: path, containerPath: path }))
        }
      />
    </Dialog>
  )
}
