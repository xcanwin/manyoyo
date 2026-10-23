import * as React from "react"

import { apiErrorData, apiPost } from "@/lib/api"
import type { ModelDenied } from "@/lib/model-denied"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// 模型地址被网络策略拦下：一键允许这个域名，再把刚才那条提示词原样重发
export function ModelDeniedNotice({
  containerName,
  denied,
  onRetry,
}: {
  containerName: string
  denied: ModelDenied
  onRetry: (prompt: string) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const { confirm, dialog } = useConfirmDialog()
  const allowUrl = `/api/containers/${encodeURIComponent(containerName)}/network/allow`

  async function handleAllow() {
    setBusy(true)
    setError("")
    try {
      try {
        await apiPost(allowUrl, { domain: denied.host })
      } catch (err) {
        if (!apiErrorData(err).data.needsConfirm) throw err
        const ok = await confirm({
          title: "放开网络限制？",
          message: `允许访问 ${denied.host} 会放开当前的网络限制，确认后才会生效。`,
          confirmLabel: "确认放开",
        })
        if (!ok) return
        await apiPost(allowUrl, { domain: denied.host, confirmRisk: true })
      }
      onRetry(denied.prompt)
    } catch (err) {
      setError(err instanceof Error ? err.message : "允许失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Alert variant="destructive" className="mx-3 mb-2 w-auto min-w-0" data-model-denied>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2 break-words">
          <span>{error || `模型地址 ${denied.host} 被网络策略拦截`}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={handleAllow}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            允许并重试
          </Button>
        </AlertDescription>
      </Alert>
      {dialog}
    </>
  )
}
