import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { QuickChatSetupDialog } from "@/components/quick-chat-setup-dialog"
import { Spinner } from "@/components/ui/spinner"
import { apiGet } from "@/lib/api"

export function QuickChatSettingsView() {
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
    load()
  }, [load])

  const configured = Boolean(path && run)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        配置好后，容器 / AGENT 列表顶部的"快捷对话"按钮会在下面这个目录下新建按时间命名的子目录，自动创建容器和
        AGENT，免去手动新建的步骤。
      </p>

      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-lg border px-4">
          <div className="flex items-center justify-between border-b py-2 text-sm last:border-b-0">
            <span className="text-muted-foreground">工作目录</span>
            <span className="font-medium">{path || "未设置"}</span>
          </div>
          <div className="flex items-center justify-between py-2 text-sm">
            <span className="text-muted-foreground">run</span>
            <span className="font-medium">{run || "未设置"}</span>
          </div>
        </div>
      )}

      <Button type="button" variant="outline" onClick={() => setSetupOpen(true)} className="w-fit">
        {configured ? "修改" : "设置"}
      </Button>

      <QuickChatSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        initialPath={path || ""}
        initialRun={run || ""}
        onSaved={() => load()}
      />
    </div>
  )
}
