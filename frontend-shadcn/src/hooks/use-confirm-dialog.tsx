import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

type ConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

type ConfirmRequest = ConfirmOptions & {
  resolve: (confirmed: boolean) => void
}

// 通用的"确认后继续"弹窗（对齐旧版 confirmFn 的用法），返回 Promise<boolean>，
// 供符号链接访问确认、大文件只读预览确认等一次性二选一场景复用。
// 用 Dialog 而不是 AlertDialog：base-ui 的 AlertDialog 默认不响应背景点击、也没有
// 右上角关闭按钮（语义上要求必须点按钮才能关闭），这个项目里所有弹窗都要能背景点击关闭
export function useConfirmDialog() {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null)

  const confirm = React.useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setRequest({ ...options, resolve })
    })
  }, [])

  function settle(value: boolean) {
    setRequest((current) => {
      current?.resolve(value)
      return null
    })
  }

  const dialog = (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogTitle>{request?.title}</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap break-all">
          {request?.message}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            {request?.cancelLabel || "取消"}
          </Button>
          <Button onClick={() => settle(true)}>{request?.confirmLabel || "继续"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { confirm, dialog }
}
