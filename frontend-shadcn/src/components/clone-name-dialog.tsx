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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export type CloneMode = "duplicate" | "clone-config"

export function CloneNameDialog({
  open,
  onOpenChange,
  mode,
  sourceContainerName,
  suggestedName,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: CloneMode
  sourceContainerName: string
  suggestedName: string
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState(suggestedName)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setName(suggestedName)
      setError("")
    }
  }, [open, suggestedName])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError("")
    try {
      await onSubmit(name.trim())
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === "duplicate" ? "复制容器" : "创建相同配置容器"}</DialogTitle>
          <DialogDescription>
            {mode === "duplicate"
              ? `将复制「${sourceContainerName}」的配置与全部 AGENT 对话历史到新容器。`
              : `将以「${sourceContainerName}」的配置创建一个新容器，不复制对话历史。`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="clone-name">新容器名称</FieldLabel>
              <Input
                id="clone-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "创建中..." : "确认"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
