import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

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
// 供符号链接访问确认、大文件只读预览确认等一次性二选一场景复用
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
    <AlertDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{request?.title}</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-wrap break-all">
          {request?.message}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" size="default" onClick={() => settle(false)}>
            {request?.cancelLabel || "取消"}
          </AlertDialogCancel>
          <Button onClick={() => settle(true)}>{request?.confirmLabel || "继续"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { confirm, dialog }
}
