import * as React from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"

export type UnsavedChangesResult = "proceed" | "cancel"

type Request = {
  fileName: string
  save: () => Promise<boolean>
  resolve: (result: UnsavedChangesResult) => void
}

// 文件编辑器专用的"保存 / 不保存 / 取消"三选一弹窗，与通用的 useConfirmDialog
// （只有二选一）区分开，供 App 级别的离开守卫复用。save 失败时不关闭页面导航，
// 留在原地让 FilesPanel 自己的错误提示可见。用 Dialog 而不是 AlertDialog，理由同
// useConfirmDialog：这里也要支持右上角关闭按钮和背景点击关闭
export function useUnsavedChangesDialog() {
  const [request, setRequest] = React.useState<Request | null>(null)
  const [saving, setSaving] = React.useState(false)

  const ask = React.useCallback(
    (fileName: string, save: () => Promise<boolean>): Promise<UnsavedChangesResult> => {
      return new Promise((resolve) => {
        setRequest({ fileName, save, resolve })
      })
    },
    []
  )

  function settle(result: UnsavedChangesResult) {
    setRequest((current) => {
      current?.resolve(result)
      return null
    })
  }

  async function handleSave() {
    if (!request || saving) return
    setSaving(true)
    const ok = await request.save()
    setSaving(false)
    settle(ok ? "proceed" : "cancel")
  }

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next && !saving) settle("cancel")
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogTitle className="sr-only">有未保存的修改</DialogTitle>
        <DialogDescription className="text-foreground">
          是否要保存对 {request?.fileName} 的更改？
          <br />
          如果不保存，你的更改将丢失。
        </DialogDescription>
        <DialogFooter>
          <Button disabled={saving} onClick={handleSave}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            保存
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => settle("proceed")}>
            不保存
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => settle("cancel")}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { ask, dialog }
}
