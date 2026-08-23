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

export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  initialValue,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  label: string
  initialValue: string
  onSubmit: (value: string) => Promise<void>
}) {
  const [value, setValue] = React.useState(initialValue)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setValue(initialValue)
      setError("")
    }
  }, [open, initialValue])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError("")
    try {
      await onSubmit(value.trim())
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="prompt-dialog-input">{label}</FieldLabel>
              <Input
                id="prompt-dialog-input"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
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
              {submitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
