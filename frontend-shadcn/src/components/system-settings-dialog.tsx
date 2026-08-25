import * as React from "react"
import JSON5 from "json5"

import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CapacityEstimateView } from "@/components/capacity-estimate-view"
import { CodeMirrorEditor } from "@/components/code-mirror-editor"
import { QuickChatSettingsView } from "@/components/quick-chat-settings-view"
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
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPut } from "@/lib/api"
import { applyTextReplacements, findValueRangeByPath } from "@/lib/json5-path-edit"

// 与后端 SENSITIVE_CONFIG_KEY_PATTERN（lib/web/server.js）保持一致，
// 命中的字段一律当密钥处理：不回显真实值，留空即视为不修改
const SENSITIVE_KEY_PATTERN = /(pass(word)?|passwd|secret|token|api(?:_|-)?key|auth(?:_|-)?token|oauth(?:_|-)?token)$/i

type ConfigCategory = {
  id: string
  label: string
  keys: string[]
}

const CATEGORIES: ConfigCategory[] = [
  // 主题是前端本地记忆（theme-provider 存 localStorage），不落进 manyoyo.json，
  // keys 留空即可，跟 quick-chat/capacity 一样走自定义渲染分支
  { id: "page", label: "页面", keys: [] },
  {
    id: "basic",
    label: "基础",
    keys: ["containerName", "hostPath", "containerPath", "imageName", "imageVersion", "containerMode"],
  },
  { id: "runtime", label: "启动环境", keys: ["envFile", "env", "volumes", "ports", "first"] },
  { id: "command", label: "运行命令", keys: ["shellPrefix", "shell", "shellSuffix", "agentPromptCommand", "yolo", "quiet"] },
  { id: "build", label: "构建参数", keys: ["imageBuildArgs"] },
  { id: "web", label: "Web 服务", keys: ["serverUser", "serverPass", "serve"] },
  { id: "plugins", label: "插件", keys: ["plugins"] },
  { id: "runs", label: "运行配置", keys: ["runs"] },
  { id: "quick-chat", label: "快捷对话", keys: [] },
  { id: "capacity", label: "容量预估", keys: [] },
]

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
  if (kind === "array") return Array.isArray(value) ? value.map((item) => String(item)).join("\n") : ""
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

function ConfigLeafField({ path, value, onCommit }: { path: string[]; value: unknown; onCommit: LeafCommit }) {
  const label = path[path.length - 1]
  const fieldId = `config-field-${path.join(".")}`
  const kind = classifyLeaf(label, value)
  const [text, setText] = React.useState(() => leafValueToEditText(kind, value))

  function commit(nextText: string) {
    onCommit(path, leafEditTextToJsonLiteral(kind, nextText), leafEditTextToValue(kind, nextText))
  }

  if (kind === "boolean") {
    return (
      <Field orientation="horizontal" className="justify-between">
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
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
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
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
          className="min-h-16 overflow-x-auto font-mono text-xs whitespace-pre"
        />
      </Field>
    )
  }

  if (kind === "secret") {
    return (
      <Field>
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
        <Input
          id={fieldId}
          type="password"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text) commit(text)
          }}
          placeholder="敏感值已隐藏，留空则保留原值"
          autoComplete="off"
        />
      </Field>
    )
  }

  if (kind === "number") {
    return (
      <Field>
        <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
        <Input id={fieldId} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commit(text)} inputMode="decimal" />
      </Field>
    )
  }

  return (
    <Field>
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <Input
        id={fieldId}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          commit(event.target.value)
        }}
      />
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
    return (
      <FieldSet className="gap-3 rounded-lg border bg-muted/30 p-3">
        <FieldLegend variant="legend" className="text-sm font-semibold text-foreground">
          {path[path.length - 1]}
        </FieldLegend>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">空</p>
        ) : (
          entries.map(([key, item]) => (
            <ConfigValueGroup key={key} path={[...path, key]} value={item} onCommit={onCommit} depth={depth + 1} />
          ))
        )}
      </FieldSet>
    )
  }
  return (
    <div className={cn(depth > 0 && "pl-1")}>
      <ConfigLeafField path={path} value={value} onCommit={onCommit} />
    </div>
  )
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
    return <p className="p-4 text-sm text-muted-foreground">当前配置中该分类暂无内容，如需新增字段请切换到 JSON 视图编辑。</p>
  }
  return (
    <FieldGroup>
      {presentKeys.map((key) => (
        <ConfigValueGroup key={key} path={[key]} value={liveParsed[key]} onCommit={onCommit} />
      ))}
    </FieldGroup>
  )
}

function RunsCategoryFields({ liveParsed, onCommit }: { liveParsed: Record<string, unknown>; onCommit: LeafCommit }) {
  const runs = isPlainObject(liveParsed.runs) ? liveParsed.runs : {}
  const runNames = Object.keys(runs)
  const [selected, setSelected] = React.useState(runNames[0] || "")
  // runs 增删（切回分类视图后 key 集合可能变化）不用 setState 同步，直接在渲染时兜底选中第一个
  const effectiveSelected = runNames.includes(selected) ? selected : runNames[0] || ""

  if (runNames.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">当前未配置任何 run，可在 JSON 视图中添加。</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel>选择 run</FieldLabel>
        <Select value={effectiveSelected} onValueChange={(value) => setSelected(value ?? "")}>
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [path, setPath] = React.useState("")
  const [raw, setRaw] = React.useState("")
  const [liveParsed, setLiveParsed] = React.useState<Record<string, unknown>>({})
  const [formVersion, setFormVersion] = React.useState(0)
  const [viewMode, setViewMode] = React.useState<"form" | "json">("form")
  const [activeCategory, setActiveCategory] = React.useState(CATEGORIES[0].id)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const [success, setSuccess] = React.useState("")
  const { theme, setTheme } = useTheme()

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    setSuccess("")
    apiGet("/api/config")
      .then((data) => {
        const nextRaw = String(data.raw || "")
        setPath(String(data.path || ""))
        setRaw(nextRaw)
        // 表单要展示真实当前值，不能用接口里的 parsed 字段——那是给其它场景用的强脱敏
        // 结构（所有数组内容一律替换成 "***"），直接从 raw 解析才是这里需要的真值来源
        setLiveParsed(nextRaw ? JSON5.parse(nextRaw) : {})
        setFormVersion((v) => v + 1)
        setViewMode("form")
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载配置失败"))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

  function handleLeafCommit(fieldPath: string[], valueText: string, jsValue: unknown) {
    setRaw((prevRaw) => {
      const range = findValueRangeByPath(prevRaw, fieldPath)
      if (!range) return prevRaw
      return applyTextReplacements(prevRaw, [{ start: range.start, end: range.end, text: valueText }])
    })
    setLiveParsed((prev) => setAtPath(prev, fieldPath, jsValue) as Record<string, unknown>)
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
      setError(err instanceof Error ? `JSON 内容有误，无法切回分类设置：${err.message}` : "JSON 内容有误，无法切回分类设置")
    }
  }

  async function handleSave() {
    setSaving(true)
    setError("")
    setSuccess("")
    try {
      await apiPut("/api/config", { raw })
      setSuccess("已保存")
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>系统设置</DialogTitle>
          <DialogDescription>{path || "~/.manyoyo/manyoyo.json"}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">加载中...</div>
          ) : viewMode === "json" ? (
            <div className="h-full min-h-72">
              <CodeMirrorEditor value={raw} language="json" readOnly={false} onChange={setRaw} />
            </div>
          ) : (
            <Tabs
              key={formVersion}
              value={activeCategory}
              onValueChange={(value) => setActiveCategory(String(value))}
              orientation="vertical"
              className="h-full min-h-72"
            >
              <TabsList variant="line" className="w-36 shrink-0">
                {CATEGORIES.map((category) => (
                  <TabsTrigger key={category.id} value={category.id}>
                    {category.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="min-h-0 flex-1 overflow-y-auto pl-4">
                {CATEGORIES.map((category) => (
                  <TabsContent key={category.id} value={category.id} className="mt-0">
                    {category.id === "page" ? (
                      <FieldGroup>
                        <Field>
                          <FieldLabel>主题</FieldLabel>
                          <ToggleGroup
                            variant="outline"
                            size="sm"
                            value={[theme]}
                            onValueChange={(values) => {
                              const next = values[0]
                              if (next) setTheme(next as "light" | "dark" | "system")
                            }}
                          >
                            <ToggleGroupItem value="light">浅色</ToggleGroupItem>
                            <ToggleGroupItem value="dark">深色</ToggleGroupItem>
                            <ToggleGroupItem value="system">跟随系统</ToggleGroupItem>
                          </ToggleGroup>
                        </Field>
                      </FieldGroup>
                    ) : category.id === "runs" ? (
                      <RunsCategoryFields liveParsed={liveParsed} onCommit={handleLeafCommit} />
                    ) : category.id === "capacity" ? (
                      <CapacityEstimateView />
                    ) : category.id === "quick-chat" ? (
                      <QuickChatSettingsView />
                    ) : (
                      <CategoryFields category={category} liveParsed={liveParsed} onCommit={handleLeafCommit} />
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
          <Alert className="shrink-0">
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="shrink-0 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={viewMode === "form" ? () => setViewMode("json") : switchToFormView}
            disabled={loading}
          >
            {viewMode === "form" ? "显示 JSON 设置" : "返回分类设置"}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={load}
              disabled={loading || saving}
            >
              重新加载
            </Button>
            <Button type="button" className="w-full sm:w-auto" onClick={handleSave} disabled={loading || saving}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
