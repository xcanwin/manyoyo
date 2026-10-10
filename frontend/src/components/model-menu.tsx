import * as React from "react"

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

// 模型名原样显示（包括 [1m] 之类的后缀），不做任何改写
function ModelName({ value }: { value: string }) {
  return <span className="min-w-0 truncate">{value}</span>
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
    // 环境变量里已经配了档位模型时，列表以它为准，不再去容器里探测 CLI 内置目录
    //（又慢，列出来的还是同一批模型，菜单还会跟着跳动）
    if (!open || !sessionName || env.options.length > 0) return
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
  // 当前值是档位别名（opus 等）时，按钮上显示它对应的真实模型名
  const shown = env.options.find((option) => option.value === current)?.label || current || env.defaultModel || "默认模型"

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              className="w-28 shrink-0 justify-between sm:w-44"
              disabled={disabled}
              title={`模型：${shown}`}
            />
          }
        >
          <ModelName value={shown} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)] overflow-y-hidden">
          {/* 滚动放在内层：菜单外壳是圆角，滚动条直接贴在外壳边缘会露出直角 */}
          <div className="max-h-80 overflow-y-auto [scrollbar-width:thin]">
            <DropdownMenuGroup>
              <DropdownMenuLabel>模型</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={current} onValueChange={(value) => void select(String(value))}>
                <DropdownMenuRadioItem closeOnClick value="">
                  <ModelName value={env.defaultModel || "默认模型"} />
                  <span className="ml-auto shrink-0 text-muted-foreground">跟随默认</span>
                </DropdownMenuRadioItem>
                {extraCurrent ? (
                  <DropdownMenuRadioItem closeOnClick value={extraCurrent}>
                    <ModelName value={extraCurrent} />
                    <span className="ml-auto text-muted-foreground">自定义</span>
                  </DropdownMenuRadioItem>
                ) : null}
                {env.options.map((option) => (
                  <DropdownMenuRadioItem closeOnClick key={option.value} value={option.value}>
                    <ModelName value={option.label} />
                    {option.description ? (
                      <span className="ml-auto shrink-0 text-muted-foreground">{option.description}</span>
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
                      <DropdownMenuRadioItem closeOnClick key={model.value} value={model.value}>
                        <span className="truncate">{model.label || model.value}</span>
                        {model.label && model.label !== model.value ? (
                          <span className="ml-auto truncate text-muted-foreground">{model.value}</span>
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
          </div>
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
