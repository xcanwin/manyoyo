import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PromptDialog } from "@/components/prompt-dialog"
import { Spinner } from "@/components/ui/spinner"
import { apiGet, apiPost, type SessionSummary } from "@/lib/api"

type ModelOption = { value: string; label: string; description?: string }
type EnvOptions = { defaultModel: string; options: ModelOption[] }

// CLI 自带的目录要在容器里起一个 Agent 进程才能问到，很慢：按会话名缓存一段时间，菜单里后台补充
const CATALOG_TTL_MS = 10 * 60 * 1000
const catalogCache = new Map<string, { at: number; models: ModelOption[] }>()

// 名字末尾的 [1m] 表示 1M 上下文，不是另一个模型：显示成徽标，提交时仍原样保留
function splitContextSuffix(value: string): { name: string; oneM: boolean } {
  return value.endsWith("[1m]") ? { name: value.slice(0, -4), oneM: true } : { name: value, oneM: false }
}

function ModelName({ value }: { value: string }) {
  const { name, oneM } = splitContextSuffix(value)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{name}</span>
      {oneM ? <Badge variant="outline">1M</Badge> : null}
    </span>
  )
}

export function ModelMenu({
  session,
  disabled,
  onChanged,
}: {
  session: SessionSummary | null
  disabled: boolean
  onChanged: () => void
}) {
  const [env, setEnv] = React.useState<EnvOptions>({ defaultModel: "", options: [] })
  const [catalog, setCatalog] = React.useState<ModelOption[]>([])
  const [catalogLoading, setCatalogLoading] = React.useState(false)
  const [customOpen, setCustomOpen] = React.useState(false)
  const sessionName = session?.name ?? null
  const current = session?.model || ""

  // 选项只读宿主机上的 env 文件，毫秒级：换会话时就取一次，按钮上能直接显示默认模型名
  React.useEffect(() => {
    if (!sessionName) return
    let cancelled = false
    apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/model-options`)
      .then((data) => {
        if (cancelled) return
        setEnv({
          defaultModel: String(data.defaultModel || ""),
          options: Array.isArray(data.options) ? (data.options as ModelOption[]) : [],
        })
      })
      .catch(() => {
        if (!cancelled) setEnv({ defaultModel: "", options: [] })
      })
    return () => {
      cancelled = true
    }
  }, [sessionName])

  function handleOpenChange(open: boolean) {
    if (!open || !sessionName) return
    const hit = catalogCache.get(sessionName)
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) {
      setCatalog(hit.models)
      return
    }
    setCatalog([])
    setCatalogLoading(true)
    apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/models`)
      .then((data) => {
        const models = Array.isArray(data.models) ? (data.models as ModelOption[]) : []
        if (models.length) catalogCache.set(sessionName, { at: Date.now(), models })
        setCatalog(models)
      })
      .catch(() => setCatalog([]))
      .finally(() => setCatalogLoading(false))
  }

  async function select(value: string) {
    if (!sessionName) return
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(sessionName)}/model`, { model: value })
      onChanged()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "切换模型失败")
    }
  }

  const known = new Set(env.options.map((option) => option.value))
  // 当前值不在任何列表里（手填的自定义名）时单独列出来，让单选能显示出选中项
  const extraCurrent = current && !known.has(current) ? current : ""
  const extras = catalog.filter(
    (model) => model.value !== "default" && !known.has(model.value) && model.value !== extraCurrent
  )
  const shown = current || env.defaultModel || "默认模型"

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              className="w-28 justify-between sm:w-44"
              disabled={disabled}
              title={`模型：${shown}`}
            />
          }
        >
          <span className="truncate">{shown}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72 max-w-[calc(100vw-2rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>模型</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={current} onValueChange={(value) => void select(String(value))}>
              <DropdownMenuRadioItem value="">
                <span className="truncate">跟随默认</span>
                {env.defaultModel ? (
                  <span className="ml-auto truncate text-xs text-muted-foreground">{env.defaultModel}</span>
                ) : null}
              </DropdownMenuRadioItem>
              {extraCurrent ? (
                <DropdownMenuRadioItem value={extraCurrent}>
                  <ModelName value={extraCurrent} />
                  <span className="ml-auto text-xs text-muted-foreground">自定义</span>
                </DropdownMenuRadioItem>
              ) : null}
              {env.options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <ModelName value={option.value} />
                  {option.description ? (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          {extras.length || catalogLoading ? (
            <>
              <DropdownMenuSeparator className="mx-1 bg-border/50" />
              <DropdownMenuGroup>
                <DropdownMenuLabel>CLI 内置</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={current} onValueChange={(value) => void select(String(value))}>
                  {extras.map((model) => (
                    <DropdownMenuRadioItem key={model.value} value={model.value}>
                      <span className="truncate">{model.label || model.value}</span>
                      {model.label && model.label !== model.value ? (
                        <span className="ml-auto truncate text-xs text-muted-foreground">{model.value}</span>
                      ) : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {catalogLoading ? (
                  <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    正在加载 CLI 内置模型…
                  </div>
                ) : null}
              </DropdownMenuGroup>
            </>
          ) : null}
          <DropdownMenuSeparator className="mx-1 bg-border/50" />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setCustomOpen(true)}>自定义模型名称…</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <PromptDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        title="自定义模型名称"
        description="填写服务商支持的完整模型名；留空则跟随默认。"
        label="模型名称"
        initialValue={current}
        onSubmit={async (value) => {
          if (!sessionName) return
          await apiPost(`/api/sessions/${encodeURIComponent(sessionName)}/model`, { model: value })
          onChanged()
        }}
      />
    </>
  )
}
