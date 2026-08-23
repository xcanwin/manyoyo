import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPut } from "@/lib/api"

export function SystemSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [path, setPath] = React.useState("")
  const [raw, setRaw] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const [success, setSuccess] = React.useState("")

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    setSuccess("")
    apiGet("/api/config")
      .then((data) => {
        setPath(String(data.path || ""))
        setRaw(String(data.raw || ""))
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载配置失败"))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    if (open) load()
  }, [open, load])

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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>系统设置</DialogTitle>
          <DialogDescription>{path || "~/.manyoyo/manyoyo.json"}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            disabled={loading}
            spellCheck={false}
            className="h-full min-h-72 resize-none font-mono text-xs"
            placeholder={loading ? "加载中..." : ""}
          />
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

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={load} disabled={loading || saving}>
            重新加载
          </Button>
          <Button type="button" onClick={handleSave} disabled={loading || saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
