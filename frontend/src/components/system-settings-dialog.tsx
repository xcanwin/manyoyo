import * as React from "react"
import JSON5 from "json5"

import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CapacityEstimateView } from "@/components/capacity-estimate-view"
import { CodeMirrorEditor } from "@/components/code-mirror-editor"
import { DoctorPanel } from "@/components/doctor-panel"
import { MirrorPanel } from "@/components/mirror-panel"
import { QuickChatSettingsView } from "@/components/quick-chat-settings-view"
import { AgentInstructionsPanel } from "@/components/agent-instructions-panel"
import { ModelServicesPanel } from "@/components/model-services-panel"
import { BasicSettings } from "@/components/basic-settings"
import {
  isNotifyEnabled,
  notificationSupported,
  setNotifyEnabled,
} from "@/lib/attention"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useTheme } from "@/components/theme-provider"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Hint } from "@/components/hint"
import { KeyLabel } from "@/components/key-label"
import { Skeleton } from "@/components/ui/skeleton"
import { useIsMobile } from "@/hooks/use-mobile"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { OrphanStatesPanel } from "@/components/orphan-states-panel"
import { StoragePanel } from "@/components/storage-panel"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { apiErrorData, apiGet, apiPut } from "@/lib/api"
import { rebaseLeafEdits, type LeafEdit } from "@/lib/config-rebase"
import { configLabel } from "@/lib/config-labels"
import {
  applyTextReplacements,
  findValueRangeByPath,
  upsertTopLevelValue,
} from "@/lib/json5-path-edit"

// 与后端 SENSITIVE_CONFIG_KEY_PATTERN（lib/web/server.js）保持一致，
// 命中的字段一律当密钥处理：不回显真实值，留空即视为不修改
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|passwd|secret|token|api(?:_|-)?key|auth(?:_|-)?token|oauth(?:_|-)?token)$/i

type ConfigCategory = {
  id: string
  label: string
  keys: string[]
  // 左侧导航里按作用范围分组：界面只影响当前浏览器；新容器默认值只对之后创建的容器生效
  group: string
}

// 右侧是表格 / 面板的分类占满宽度，其余表单类分类限制 max-w-2xl、靠左（STYLE.md 第 8 节）
const WIDE_CATEGORIES = new Set([
  "model-services",
  "storage",
  "orphans",
  "doctor",
  "capacity",
])

// 左栏 / 手机分类下拉里的分组顺序
const GROUPS = [
  "界面",
  "Agent",
  "新容器默认值",
  "镜像",
  "MANYOYO 服务",
  "宿主机与维护",
]

const CATEGORIES: ConfigCategory[] = [
  // 主题是前端本地记忆（theme-provider 存 localStorage），不落进 manyoyo.json，
  // keys 留空即可，跟 quick-chat/capacity 一样走自定义渲染分支
  { id: "page", label: "页面", keys: [], group: "界面" },
  { id: "model-services", label: "模型服务", keys: [], group: "Agent" },
  { id: "quick-chat", label: "快捷对话", keys: [], group: "Agent" },
  { id: "agent-instructions", label: "系统提示词", keys: [], group: "Agent" },
  {
    id: "basic",
    label: "基础",
    keys: [
      "containerName",
      "hostPath",
      "containerPath",
      "imageName",
      "imageVersion",
      "containerMode",
    ],
    group: "新容器默认值",
  },
  {
    id: "runtime",
    label: "启动环境",
    keys: ["envFile", "env", "volumes", "ports", "first"],
    group: "新容器默认值",
  },
  {
    id: "command",
    label: "运行命令",
    keys: [
      "shellPrefix",
      "shell",
      "shellSuffix",
      "agentPromptCommand",
      "yolo",
      "quiet",
    ],
    group: "新容器默认值",
  },
  { id: "runs", label: "运行配置", keys: ["runs"], group: "新容器默认值" },
  { id: "mirrors", label: "软件源", keys: [], group: "新容器默认值" },
  { id: "build", label: "构建参数", keys: ["imageBuildArgs"], group: "镜像" },
  {
    id: "web",
    label: "Web 服务",
    keys: ["serverUser", "serverPass", "serve"],
    group: "MANYOYO 服务",
  },
  { id: "plugins", label: "插件", keys: ["plugins"], group: "MANYOYO 服务" },
  { id: "doctor", label: "环境检查", keys: [], group: "宿主机与维护" },
  { id: "capacity", label: "容量预估", keys: [], group: "宿主机与维护" },
  { id: "storage", label: "磁盘占用", keys: [], group: "宿主机与维护" },
  { id: "orphans", label: "容器状态", keys: [], group: "宿主机与维护" },
]

// 任务结束时的浏览器通知：开关只存在这台设备上；浏览器只在 HTTPS 或 localhost 下允许通知
function NotifySetting() {
  const supported = notificationSupported()
  const [enabled, setEnabled] = React.useState(
    () =>
      supported && isNotifyEnabled() && Notification.permission === "granted"
  )
  const [hint, setHint] = React.useState("")

  async function handleChange(next: boolean) {
    setHint("")
    if (!next) {
      setNotifyEnabled(false)
      setEnabled(false)
      return
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission
    if (permission !== "granted") {
      setHint("浏览器没有允许通知，请在网站设置里打开")
      return
    }
    setNotifyEnabled(true)
    setEnabled(true)
  }

  return (
    <Field orientation="horizontal" className="justify-between">
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor="notify-finished">任务结束时通知</FieldLabel>
        <FieldDescription>
          {supported
            ? hint || "页面在后台时，任务结束弹出系统通知（只写会话名）"
            : "需要用 HTTPS 或 localhost 打开才能使用"}
        </FieldDescription>
      </div>
      <Switch
        id="notify-finished"
        checked={enabled}
        disabled={!supported}
        onCheckedChange={(value) => void handleChange(Boolean(value))}
      />
    </Field>
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function setAtPath(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  const base: Record<string, unknown> = isPlainObject(root) ? { ...root } : {}
  base[head] = setAtPath(base[head], rest, value)
  return base
}

type LeafKind = "boolean" | "number" | "array" | "secret" | "string"

function classifyLeaf(key: string, value: unknown): LeafKind {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "secret"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return "number"
  if (Array.isArray(value)) return "array"
  return "string"
}

function leafValueToEditText(kind: LeafKind, value: unknown): string {
  if (kind === "boolean") return value ? "true" : "false"
  if (kind === "array")
    return Array.isArray(value)
      ? value.map((item) => String(item)).join("\n")
      : ""
  if (kind === "secret") return ""
  if (kind === "number") return typeof value === "number" ? String(value) : ""
  if (value === null || value === undefined) return ""
  return String(value)
}

function leafEditTextToJsonLiteral(kind: LeafKind, text: string): string {
  if (kind === "boolean") return text === "true" ? "true" : "false"
  if (kind === "array") {
    const items = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    return JSON.stringify(items)
  }
  if (kind === "number") {
    const num = Number(text)
    return JSON.stringify(Number.isFinite(num) ? num : 0)
  }
  return JSON.stringify(text)
}

function leafEditTextToValue(kind: LeafKind, text: string): unknown {
  if (kind === "boolean") return text === "true"
  if (kind === "array")
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  if (kind === "number") {
    const num = Number(text)
    return Number.isFinite(num) ? num : 0
  }
  return text
}

type LeafCommit = (path: string[], valueText: string, jsValue: unknown) => void

function ConfigFieldLabel({
  path,
  htmlFor,
}: {
  path: string[]
  htmlFor?: string
}) {
  return <KeyLabel path={path} htmlFor={htmlFor} />
}

function ConfigFieldDescription({ path }: { path: string[] }) {
  const desc = configLabel(path).desc
  return desc ? <FieldDescription>{desc}</FieldDescription> : null
}

function ConfigLeafField({
  path,
  value,
  onCommit,
}: {
  path: string[]
  value: unknown
  onCommit: LeafCommit
}) {
  const label = path[path.length - 1]
  const fieldId = `config-field-${path.join(".")}`
  const kind = classifyLeaf(label, value)
  const [text, setText] = React.useState(() => leafValueToEditText(kind, value))

  function commit(nextText: string) {
    onCommit(
      path,
      leafEditTextToJsonLiteral(kind, nextText),
      leafEditTextToValue(kind, nextText)
    )
  }

  if (kind === "boolean") {
    return (
      <Field orientation="horizontal" className="justify-between">
        <ConfigFieldLabel path={path} htmlFor={fieldId} />
        <Switch
          id={fieldId}
          checked={text === "true"}
          onCheckedChange={(checked) => {
            const next = checked ? "true" : "false"
            setText(next)
            commit(next)
          }}
        />
      </Field>
    )
  }

  if (kind === "array") {
    return (
      <Field>
        <ConfigFieldLabel path={path} htmlFor={fieldId} />
        <Textarea
          id={fieldId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit(text)}
          placeholder="每行一项"
          spellCheck={false}
          // 卷挂载/端口这类值经常是一整行长路径，自动换行会把路径拆断不好对齐检查——
          // 关掉自动换行，改成横向滚动
          wrap="off"
          className="min-h-16 overflow-x-auto font-mono whitespace-pre"
        />
        <ConfigFieldDescription path={path} />
      </Field>
    )
  }

  if (kind === "secret") {
    return (
      <Field>
        <ConfigFieldLabel path={path} htmlFor={fieldId} />
        <Input
          id={fieldId}
          // 不用 type=password：浏览器会把它当登录表单，弹“要保存密码吗”
          type="text"
          className="[-webkit-text-security:disc]"
          data-1p-ignore
          data-lpignore="true"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text) commit(text)
          }}
          placeholder="敏感值已隐藏，留空则保留原值"
          autoComplete="off"
        />
        <ConfigFieldDescription path={path} />
      </Field>
    )
  }

  if (kind === "number") {
    return (
      <Field>
        <ConfigFieldLabel path={path} htmlFor={fieldId} />
        <Input
          id={fieldId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit(text)}
          inputMode="decimal"
        />
        <ConfigFieldDescription path={path} />
      </Field>
    )
  }

  return (
    <Field>
      <ConfigFieldLabel path={path} htmlFor={fieldId} />
      <Input
        id={fieldId}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          commit(event.target.value)
        }}
      />
      <ConfigFieldDescription path={path} />
    </Field>
  )
}

function ConfigValueGroup({
  path,
  value,
  onCommit,
  depth = 0,
}: {
  path: string[]
  value: unknown
  onCommit: LeafCommit
  depth?: number
}) {
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    const label = configLabel(path)
    const children =
      entries.length === 0 ? (
        <p className="text-muted-foreground">空</p>
      ) : (
        entries.map(([key, item]) => (
          <ConfigValueGroup
            key={key}
            path={[...path, key]}
            value={item}
            onCommit={onCommit}
            depth={depth + 1}
          />
        ))
      )
    // 一级对象：一张卡片，标题 + 说明在卡片头
    if (depth === 0) {
      return (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-baseline gap-2">
              <span className={cn(label.mono && "font-mono")}>
                {label.title}
              </span>
              {!label.mono ? <Hint mono>{label.key}</Hint> : null}
            </CardTitle>
            {label.desc ? (
              <CardDescription>{label.desc}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">{children}</CardContent>
        </Card>
      )
    }
    // 二级及以下：不再套框，小标题加说明，子字段整体左缩进并带一条竖线；
    // 标题和子字段之间不画分割线（子字段本来就属于它）
    return (
      <FieldSet>
        <div className="flex flex-col gap-1">
          <FieldLegend
            variant="label"
            className="mb-0 flex items-baseline gap-2"
          >
            <span className={cn(label.mono && "font-mono")}>{label.title}</span>
            {!label.mono ? <Hint mono>{label.key}</Hint> : null}
          </FieldLegend>
          {label.desc ? (
            <FieldDescription>{label.desc}</FieldDescription>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 border-l-2 pl-3">{children}</div>
      </FieldSet>
    )
  }
  return <ConfigLeafField path={path} value={value} onCommit={onCommit} />
}

function CategoryFields({
  category,
  liveParsed,
  onCommit,
}: {
  category: ConfigCategory
  liveParsed: Record<string, unknown>
  onCommit: LeafCommit
}) {
  const presentKeys = category.keys.filter((key) => key in liveParsed)
  if (presentKeys.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>这个分类暂无内容</EmptyTitle>
          <EmptyDescription>
            如需新增字段，请切换到 JSON 视图编辑。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const leafKeys = presentKeys.filter((key) => !isPlainObject(liveParsed[key]))
  const objectKeys = presentKeys.filter((key) => isPlainObject(liveParsed[key]))
  return (
    <div className="flex flex-col gap-4">
      {leafKeys.length > 0 ? (
        <Card>
          <CardContent>
            <FieldGroup>
              {leafKeys.map((key) => (
                <ConfigValueGroup
                  key={key}
                  path={[key]}
                  value={liveParsed[key]}
                  onCommit={onCommit}
                />
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}
      {objectKeys.map((key) => (
        <ConfigValueGroup
          key={key}
          path={[key]}
          value={liveParsed[key]}
          onCommit={onCommit}
        />
      ))}
    </div>
  )
}

function RunsCategoryFields({
  liveParsed,
  onCommit,
}: {
  liveParsed: Record<string, unknown>
  onCommit: LeafCommit
}) {
  const runs = isPlainObject(liveParsed.runs) ? liveParsed.runs : {}
  const runNames = Object.keys(runs)
  const [selected, setSelected] = React.useState(runNames[0] || "")
  // runs 增删（切回分类视图后 key 集合可能变化）不用 setState 同步，直接在渲染时兜底选中第一个
  const effectiveSelected = runNames.includes(selected)
    ? selected
    : runNames[0] || ""

  if (runNames.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>还没有运行配置</EmptyTitle>
          <EmptyDescription>
            可在 JSON 视图中添加，或到「模型服务」里添加一套。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>选择 run</FieldLabel>
        <Select
          value={effectiveSelected}
          onValueChange={(value) => setSelected(value ?? "")}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择 run" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {runNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {effectiveSelected ? (
        <FieldGroup>
          <ConfigValueGroup
            key={effectiveSelected}
            path={["runs", effectiveSelected]}
            value={runs[effectiveSelected]}
            onCommit={onCommit}
          />
        </FieldGroup>
      ) : null}
    </div>
  )
}

export function SystemSettingsDialog({
  open,
  onOpenChange,
  currentContainer,
  openableContainers,
  onOpenContainer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentContainer?: string
  openableContainers?: string[]
  onOpenContainer?: (name: string) => void
}) {
  const [path, setPath] = React.useState("")
  const [raw, setRaw] = React.useState("")
  const [liveParsed, setLiveParsed] = React.useState<Record<string, unknown>>(
    {}
  )
  const [formVersion, setFormVersion] = React.useState(0)
  const [viewMode, setViewMode] = React.useState<"form" | "json">("form")
  const isMobile = useIsMobile()
  const [activeCategory, setActiveCategory] = React.useState(CATEGORIES[0].id)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const [success, setSuccess] = React.useState("")
  // 配置文件的版本（磁盘原文的哈希）：保存时带上，别处改过文件就会收到冲突，而不是悄悄覆盖
  const etagRef = React.useRef("")
  // 自己改过的字段（表单模式）：冲突时在最新内容上重放；baseRawRef 是这些修改所基于的文本
  const editsRef = React.useRef<LeafEdit[]>([])
  const baseRawRef = React.useRef("")
  // JSON 文本是整段手改的，没法按字段重放：冲突时让用户选
  const jsonDirtyRef = React.useRef(false)
  // JSON 文本每被改一次就 +1：保存期间又改了，成功后不能把“已手改”标记清掉
  const jsonEditSeqRef = React.useRef(0)
  const [jsonConflict, setJsonConflict] = React.useState<{
    etag: string
    raw: string
  } | null>(null)
  const { theme, setTheme } = useTheme()

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    setSuccess("")
    apiGet("/api/config")
      .then((data) => {
        const nextRaw = String(data.raw || "")
        etagRef.current = String(data.etag || "")
        editsRef.current = []
        baseRawRef.current = nextRaw
        jsonDirtyRef.current = false
        setJsonConflict(null)
        setPath(String(data.path || ""))
        setRaw(nextRaw)
        // 表单要展示真实当前值，不能用接口里的 parsed 字段——那是给其它场景用的强脱敏
        // 结构（所有数组内容一律替换成 "***"），直接从 raw 解析才是这里需要的真值来源
        setLiveParsed(nextRaw ? JSON5.parse(nextRaw) : {})
        setFormVersion((v) => v + 1)
        setViewMode("form")
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载配置失败")
      )
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    if (open) queueMicrotask(() => load())
  }, [open, load])

  function handleLeafCommit(
    fieldPath: string[],
    valueText: string,
    jsValue: unknown
  ) {
    editsRef.current = [...editsRef.current, { path: fieldPath, valueText }]
    setRaw((prevRaw) => {
      const range = findValueRangeByPath(prevRaw, fieldPath)
      if (!range) {
        // 配置里原来没有的顶层字段（基础分类里新填的）：加进去；留空不用加
        if (fieldPath.length === 1 && valueText !== '""')
          return upsertTopLevelValue(prevRaw, fieldPath[0], valueText)
        return prevRaw
      }
      return applyTextReplacements(prevRaw, [
        { start: range.start, end: range.end, text: valueText },
      ])
    })
    setLiveParsed(
      (prev) => setAtPath(prev, fieldPath, jsValue) as Record<string, unknown>
    )
  }

  // 在最新的服务端内容上重放自己改过的字段，并换成最新的版本号。
  // 返回 null：JSON 文本被手改过，没法重放；返回 { unparsable: true }：最新内容无法解析（被改坏了），什么都不动，保住用户的修改。
  function rebaseOnto(fresh: { raw: string; etag: string }) {
    if (jsonDirtyRef.current) return null
    const result = rebaseLeafEdits(
      fresh.raw,
      editsRef.current,
      baseRawRef.current
    )
    let parsed: Record<string, unknown>
    try {
      if (!fresh.raw.trim()) throw new Error("empty")
      parsed = JSON5.parse(result.raw)
    } catch {
      return { unparsable: true as const }
    }
    etagRef.current = fresh.etag
    baseRawRef.current = fresh.raw
    setRaw(result.raw)
    setLiveParsed(parsed)
    // 只让分类里的表单字段重新挂载（输入框各自持有文本，换了内容要重新挂载才会显示最新值）；
    // 子面板（快捷对话、软件源）不重新挂载，它们里面还没保存的选择不能丢
    setFormVersion((v) => v + 1)
    return { unparsable: false as const, ...result }
  }

  // 子面板（快捷对话、软件源）自己直接写了配置文件：把最新版本号和内容接过来，稍后点“保存”不会再用旧值覆盖回去
  async function handleSubPanelSaved() {
    try {
      const data = await apiGet("/api/config")
      const fresh = {
        raw: String(data.raw || ""),
        etag: String(data.etag || ""),
      }
      if (jsonDirtyRef.current) {
        // JSON 文本手改过，没法按字段合并：立刻让用户选，而不是稍后点保存时才悄悄覆盖掉子面板刚写的值
        setJsonConflict(fresh)
        return
      }
      rebaseOnto(fresh)
    } catch {
      // 拿不到最新内容就保持旧版本号：之后点“保存”会收到冲突提示，不会悄悄覆盖
    }
  }

  async function putConfig(nextRaw: string, etag: string) {
    return apiPut("/api/config", { raw: nextRaw }, { "If-Match": etag })
  }

  function describeRebase(result: { missing: string[]; overridden: string[] }) {
    const parts = ["配置文件刚被其他地方修改过，已在最新内容上保存你的修改。"]
    if (result.overridden.length)
      parts.push(`${result.overridden.join("、")} 两边都改了，以你的为准。`)
    if (result.missing.length)
      parts.push(
        `${result.missing.join("、")} 在最新内容里已经不存在，这项修改没有保存。`
      )
    return parts.join("")
  }

  async function handleSave(options: { forceEtag?: string } = {}) {
    setSaving(true)
    setError("")
    setSuccess("")
    setJsonConflict(null)
    let nextRaw = raw
    let etag = options.forceEtag ?? etagRef.current
    let rebased: { missing: string[]; overridden: string[] } | null = null
    try {
      // 冲突后最多自动在最新内容上重放并重试一次
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // 保存期间用户还可能继续改：只清掉这次已经提交的那部分
        const sentEdits = editsRef.current.length
        const sentJsonSeq = jsonEditSeqRef.current
        try {
          const data = await putConfig(nextRaw, etag)
          etagRef.current = String(data.etag || "")
          editsRef.current = editsRef.current.slice(sentEdits)
          baseRawRef.current = nextRaw
          if (jsonEditSeqRef.current === sentJsonSeq)
            jsonDirtyRef.current = false
          setSuccess(rebased ? describeRebase(rebased) : "已保存")
          return
        } catch (err) {
          const { status, data } = apiErrorData(err)
          if (status !== 409 || data.conflict !== true) throw err
          const fresh = {
            raw: String(data.raw || ""),
            etag: String(data.etag || ""),
          }
          if (jsonDirtyRef.current) {
            setJsonConflict(fresh)
            return
          }
          const result = rebaseOnto(fresh)
          if (!result) return
          if (result.unparsable) {
            setError(
              "配置文件当前无法解析（可能被其他地方改坏了），你的修改还在这里；修好文件后再保存，或点“重新加载”放弃修改"
            )
            return
          }
          if (attempt === 1) {
            setError(
              "配置文件一直在被其他地方修改，你的修改还没有保存，请再点一次保存"
            )
            return
          }
          nextRaw = result.raw
          etag = fresh.etag
          rebased = { missing: result.missing, overridden: result.overridden }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  function switchToFormView() {
    try {
      const parsedAgain = JSON5.parse(raw)
      if (!isPlainObject(parsedAgain)) throw new Error("配置根节点必须是对象")
      setLiveParsed(parsedAgain)
      setFormVersion((v) => v + 1)
      setError("")
      setViewMode("form")
    } catch (err) {
      setError(
        err instanceof Error
          ? `JSON 内容有误，无法切回分类设置：${err.message}`
          : "JSON 内容有误，无法切回分类设置"
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>系统设置</DialogTitle>
          <DialogDescription>
            {path || "~/.manyoyo/manyoyo.json"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div
              className="flex flex-col gap-2"
              role="status"
              aria-label="加载中"
            >
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : viewMode === "json" ? (
            <div className="h-full min-h-72">
              {/* 配置文件是 JSON5：key 不带引号、可以写注释和尾逗号。用 json 模式解析
                  会整片报错，缩进/高亮跟着失效——JSON5 本质就是 JS 对象字面量，
                  用 javascript 模式才能正确缩进与高亮 */}
              <CodeMirrorEditor
                value={raw}
                language="javascript"
                readOnly={false}
                onChange={(text) => {
                  jsonDirtyRef.current = true
                  jsonEditSeqRef.current += 1
                  setRaw(text)
                }}
              />
            </div>
          ) : (
            <Tabs
              value={activeCategory}
              onValueChange={(value) => setActiveCategory(String(value))}
              orientation={isMobile ? "horizontal" : "vertical"}
              className="h-full min-h-72 max-md:flex-col"
            >
              {/* 手机上左侧分类栏变成顶部的分类下拉（STYLE.md 第 12 节） */}
              {isMobile ? (
                <Select
                  value={activeCategory}
                  onValueChange={(value) =>
                    setActiveCategory(String(value ?? CATEGORIES[0].id))
                  }
                >
                  <SelectTrigger aria-label="设置分类" className="w-full">
                    <SelectValue>
                      {(value: string | null) =>
                        CATEGORIES.find((c) => c.id === value)?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {GROUPS.map((group) => (
                      <SelectGroup key={group}>
                        <SelectLabel>{group}</SelectLabel>
                        {CATEGORIES.filter((c) => c.group === group).map(
                          (c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.label}
                            </SelectItem>
                          )
                        )}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                /* 分类多、矮窗口放不下：限制在弹窗高度内、从顶部排起，超出可以上下滚动 */
                <TabsList
                  variant="line"
                  className="max-h-full w-40 shrink-0 justify-start overflow-y-auto"
                >
                  {CATEGORIES.map((category, index) => (
                    <React.Fragment key={category.id}>
                      {index === 0 ||
                      CATEGORIES[index - 1].group !== category.group ? (
                        <Hint
                          aria-hidden="true"
                          data-group={category.group}
                          className={cn(
                            "block w-full self-stretch px-2 pb-1 text-left",
                            index > 0 && "pt-3"
                          )}
                        >
                          {category.group}
                        </Hint>
                      ) : null}
                      <TabsTrigger
                        value={category.id}
                        className="text-foreground after:hidden hover:bg-muted/60 group-data-[variant=line]/tabs-list:hover:bg-muted/60 dark:text-foreground group-data-[variant=line]/tabs-list:data-active:bg-muted dark:group-data-[variant=line]/tabs-list:data-active:bg-muted"
                      >
                        {category.label}
                      </TabsTrigger>
                    </React.Fragment>
                  ))}
                </TabsList>
              )}
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1 pr-1 md:pl-4">
                {CATEGORIES.map((category) => (
                  <TabsContent
                    key={category.id}
                    value={category.id}
                    className={cn(
                      "mt-0",
                      !WIDE_CATEGORIES.has(category.id) && "max-w-2xl"
                    )}
                  >
                    {category.id === "page" ? (
                      <FieldGroup>
                        <Field>
                          <FieldLabel>主题</FieldLabel>
                          <ToggleGroup
                            variant="outline"
                            value={[theme]}
                            onValueChange={(values) => {
                              const next = values[0]
                              if (next)
                                setTheme(next as "light" | "dark" | "system")
                            }}
                          >
                            <ToggleGroupItem value="light">
                              浅色
                            </ToggleGroupItem>
                            <ToggleGroupItem value="dark">深色</ToggleGroupItem>
                            <ToggleGroupItem value="system">
                              跟随系统
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </Field>
                        <NotifySetting />
                      </FieldGroup>
                    ) : category.id === "runs" ? (
                      <RunsCategoryFields
                        key={formVersion}
                        liveParsed={liveParsed}
                        onCommit={handleLeafCommit}
                      />
                    ) : category.id === "basic" ? (
                      <BasicSettings
                        key={formVersion}
                        liveParsed={liveParsed}
                        onCommit={handleLeafCommit}
                      />
                    ) : category.id === "capacity" ? (
                      <CapacityEstimateView />
                    ) : category.id === "mirrors" ? (
                      <MirrorPanel onSaved={handleSubPanelSaved} />
                    ) : category.id === "doctor" ? (
                      <DoctorPanel />
                    ) : category.id === "storage" ? (
                      <StoragePanel
                        currentContainer={currentContainer}
                        openableContainers={openableContainers}
                        onOpenContainer={onOpenContainer}
                      />
                    ) : category.id === "orphans" ? (
                      <OrphanStatesPanel />
                    ) : category.id === "model-services" ? (
                      <ModelServicesPanel onSaved={handleSubPanelSaved} />
                    ) : category.id === "quick-chat" ? (
                      <QuickChatSettingsView onSaved={handleSubPanelSaved} />
                    ) : category.id === "agent-instructions" ? (
                      <AgentInstructionsPanel onSaved={handleSubPanelSaved} />
                    ) : (
                      <CategoryFields
                        key={formVersion}
                        category={category}
                        liveParsed={liveParsed}
                        onCommit={handleLeafCommit}
                      />
                    )}
                  </TabsContent>
                ))}
              </div>
            </Tabs>
          )}
        </div>

        {error ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {success ? (
          <Alert variant="success" className="shrink-0">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        ) : null}
        {jsonConflict ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              配置文件刚被其他地方修改过，还没有保存。
              <Button variant="outline" size="sm" onClick={load}>
                重新加载（放弃我的修改）
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void handleSave({ forceEtag: jsonConflict.etag })
                }
              >
                仍然保存（覆盖对方的修改）
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={
              viewMode === "form" ? () => setViewMode("json") : switchToFormView
            }
            disabled={loading}
          >
            {viewMode === "form" ? "显示 JSON 设置" : "返回分类设置"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={load}
              disabled={loading || saving}
            >
              重新加载
            </Button>
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={loading || saving}
            >
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
