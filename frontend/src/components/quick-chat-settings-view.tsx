import * as React from "react"

import { KeyValueList } from "@/components/key-value-list"
import { PageHeader } from "@/components/page-header"
import { QuickChatSetupDialog } from "@/components/quick-chat-setup-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"

export function QuickChatSettingsView({
  onSaved,
}: { onSaved?: () => void } = {}) {
  const [path, setPath] = React.useState<string | null>(null)
  const [run, setRun] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [setupOpen, setSetupOpen] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    apiGet("/api/system/quick-chat-config")
      .then((data) => {
        setPath(typeof data.path === "string" ? data.path : null)
        setRun(typeof data.run === "string" ? data.run : null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => load())
  }, [load])

  const configured = Boolean(path && run)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="快捷对话"
        description="配置好后，容器 / AGENT 列表顶部的“快捷对话”按钮会在下面这个目录下新建按时间命名的子目录，自动创建容器和 AGENT，免去手动新建的步骤。"
        actions={
          <Button
            type="button"
            variant={configured ? "outline" : "default"}
            onClick={() => setSetupOpen(true)}
          >
            {configured ? "修改" : "设置"}
          </Button>
        }
      />

      {loading ? (
        <div className="flex flex-col gap-2" role="status" aria-label="加载中">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <KeyValueList
              items={[
                {
                  label: "工作目录",
                  value: path ? (
                    <span className="font-mono">{path}</span>
                  ) : (
                    "未设置"
                  ),
                },
                { label: "运行配置", value: run || "未设置" },
              ]}
            />
          </CardContent>
        </Card>
      )}

      <QuickChatSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        initialPath={path || ""}
        initialRun={run || ""}
        onSaved={() => {
          load()
          onSaved?.()
        }}
      />
    </div>
  )
}
