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
import { DirectoryPickerDialog } from "@/components/directory-picker-dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { apiGet, apiPut } from "@/lib/api"

const DEFAULT_QUICK_CHAT_PATH = "~/.manyoyo/workpath/"

export function QuickChatSetupDialog({
  open,
  onOpenChange,
  initialPath,
  initialRun,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath: string
  initialRun: string
  onSaved: (path: string, run: string) => void
}) {
  const [path, setPath] = React.useState(DEFAULT_QUICK_CHAT_PATH)
  const [run, setRun] = React.useState("")
  const [runs, setRuns] = React.useState<string[]>([])
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setError("")
    setPath(initialPath || DEFAULT_QUICK_CHAT_PATH)
    setRun(initialRun || "")
    apiGet("/api/config")
      .then((data) => {
        const parsed = (data.parsed || {}) as Record<string, unknown>
        const runsMap = parsed.runs && typeof parsed.runs === "object" ? (parsed.runs as Record<string, unknown>) : {}
        setRuns(Object.keys(runsMap))
      })
      .catch(() => setRuns([]))
    // initialPath/initialRun 只在弹窗刚打开那一刻取一次初值，避免用户编辑过程中被外部刷新打断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function handleSave() {
    if (!path.trim()) {
      setError("请填写工作目录")
      return
    }
    if (!run) {
      setError("请选择一个 run")
      return
    }
    setSaving(true)
    setError("")
    try {
      await apiPut("/api/system/quick-chat-config", { path: path.trim(), run })
      onSaved(path.trim(), run)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置快捷对话</DialogTitle>
          <DialogDescription>
            设置一个主目录，之后每次点击"快捷对话"都会在这个目录下新建一个按时间命名的子目录、并用它自动创建容器和
            AGENT，免去手动新建容器 + 新建 AGENT 的步骤。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="quick-chat-path">工作目录</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="quick-chat-path"
                placeholder={DEFAULT_QUICK_CHAT_PATH}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                选择
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="quick-chat-run">run</FieldLabel>
            <Select value={run} onValueChange={(value) => setRun(value ?? "")}>
              <SelectTrigger id="quick-chat-run" className="w-full">
                <SelectValue placeholder="选择一个 run" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {runs.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={path}
        onSelect={(selected) => setPath(selected)}
      />
    </Dialog>
  )
}
