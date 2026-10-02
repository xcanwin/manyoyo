import * as React from "react"

import { MirrorSettings } from "@/components/mirror-settings"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { fetchSetupStatus } from "@/lib/setup"
import {
  emptyMirrors,
  emptyPresets,
  fetchMirrorPresets,
  saveMirrors,
  validateMirrors,
  type MirrorPresets,
  type Mirrors,
} from "@/lib/mirrors"

// 系统设置里的“软件源”：读当前配置，改完保存；只对之后新建的容器生效
export function MirrorPanel() {
  const [mirrors, setMirrors] = React.useState<Mirrors>(emptyMirrors())
  const [presets, setPresets] = React.useState<MirrorPresets>(emptyPresets())
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    Promise.all([fetchSetupStatus(), fetchMirrorPresets().catch(() => emptyPresets())])
      .then(([status, list]) => {
        if (cancelled) return
        setMirrors({ ...emptyMirrors(), ...(status.mirrors ?? {}) })
        setPresets(list)
      })
      .catch((err) => {
        if (!cancelled) setMessage({ tone: "error", text: err instanceof Error ? err.message : "加载失败" })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    const reason = validateMirrors(mirrors)
    if (reason) {
      setMessage({ tone: "error", text: reason })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await saveMirrors(mirrors)
      setMessage({ tone: "ok", text: "已保存，之后新建的容器会使用这些软件源" })
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "保存失败" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        默认使用各工具的官方源。改完只对之后新建的容器生效，已有容器不变。
      </p>
      <MirrorSettings mirrors={mirrors} presets={presets} onChange={setMirrors} idPrefix="settings-mirror" />
      {message ? (
        <Alert variant={message.tone === "error" ? "destructive" : undefined}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner data-icon="inline-start" /> : null}
          保存
        </Button>
      </div>
    </div>
  )
}
