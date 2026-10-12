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
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { api, type DirtyFile, type Suggestion } from "./api"

function Commands({ commands }: { commands: string[] }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
      {commands.join("\n")}
    </pre>
  )
}

/** 对外动作的确认：列出将执行的完整命令 */
export function ConfirmDialog({
  title,
  commands,
  onConfirm,
  onCancel,
  confirmText = "确认执行",
}: {
  title: string
  commands: string[]
  onConfirm: () => void
  onCancel: () => void
  confirmText?: string
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认：{title}</DialogTitle>
          <DialogDescription>这是对外动作，将执行下面的命令。</DialogDescription>
        </DialogHeader>
        <Commands commands={commands} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>{confirmText}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 一键发布：推送 main 并交给 GitHub Actions 自动完成，只需点一次「开始」 */
export function RemoteDialog({
  version,
  willBump,
  commits,
  notes,
  problem,
  onStart,
  onCancel,
}: {
  version: string
  willBump: boolean
  commits: string[]
  notes: string
  problem: string
  onStart: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>一键发布 v{version}</DialogTitle>
          <DialogDescription>
            {willBump ? `版本号还没升，会自动升到 ${version} 并提交。` : ""}
            会推送 main 并交给 GitHub Actions 自动完成（测试、构建、验证、公开、发 npm），之后可以关掉页面和电脑。
          </DialogDescription>
        </DialogHeader>
        {problem && (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-1 text-sm">
          <p className="font-medium">这次的改动（{commits.length} 个提交）</p>
          <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-muted-foreground">
            {commits.map((commit, index) => (
              <li key={`${index}-${commit}`} className="break-all">
                {commit}
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-1 text-sm">
          <p className="font-medium">Release 说明（自动生成）</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">{notes}</pre>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={Boolean(problem)} onClick={onStart}>
            开始
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function VersionDialog({
  current,
  imageVersion,
  suggestions,
  onSubmit,
  onCancel,
}: {
  current: string
  imageVersion: string
  suggestions: Suggestion[]
  onSubmit: (version: string, imageVersion: string) => Promise<void>
  onCancel: () => void
}) {
  const [version, setVersion] = React.useState(suggestions.find((item) => item.recommended)?.version ?? current)
  const [image, setImage] = React.useState(imageVersion)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  async function submit() {
    setBusy(true)
    setError("")
    try {
      await onSubmit(version.trim(), image.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : "失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>选择版本</DialogTitle>
          <DialogDescription>当前 {current}。镜像内容没变时不要改镜像版本。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((item) => (
            <Button key={item.key} variant={version === item.version ? "default" : "outline"} size="sm" onClick={() => setVersion(item.version)}>
              {item.key} → {item.version}
            </Button>
          ))}
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">版本号</span>
          <Input value={version} onChange={(event) => setVersion(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">镜像版本（改了会同步文档里的镜像示例）</span>
          <Input value={image} onChange={(event) => setImage(event.target.value)} />
        </label>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={busy || !version.trim()} onClick={submit}>
            {busy && <Spinner />}更新版本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CommitDialog({
  files,
  ruleMessage,
  onSubmit,
  onCancel,
}: {
  files: DirtyFile[]
  ruleMessage: string
  onSubmit: (files: string[], message: string) => Promise<void>
  onCancel: () => void
}) {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(files.map((file) => file.path)))
  const [message, setMessage] = React.useState(ruleMessage)
  const [busy, setBusy] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState("")

  function toggle(path: string) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  async function generate(mode: "rule" | "agent") {
    setGenerating(true)
    setNote(mode === "agent" ? "正在通过容器内 Agent 生成（最长约 90 秒）…" : "")
    try {
      const result = await api<{ message: string | null; reason: string }>("/api/commit-message", { mode, files: [...selected] })
      if (result.message) {
        setMessage(result.message)
        setNote("")
      } else {
        setNote(result.reason || "没有生成结果")
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "生成失败")
    } finally {
      setGenerating(false)
    }
  }

  async function submit() {
    setBusy(true)
    setError("")
    try {
      await onSubmit([...selected], message)
    } catch (err) {
      setError(err instanceof Error ? err.message : "失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>提交</DialogTitle>
          <DialogDescription>只提交勾选的文件。提交说明可以规则生成、容器内 Agent 生成，或直接手改。</DialogDescription>
        </DialogHeader>
        <div className="max-h-48 space-y-1 overflow-auto rounded-md border p-2 text-sm">
          {files.map((file) => (
            <label key={file.path} className="flex items-center gap-2">
              <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} />
              <span className="w-6 text-muted-foreground">{file.code}</span>
              <span className="truncate font-mono text-xs">{file.path}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={generating} onClick={() => generate("rule")}>
            规则生成
          </Button>
          <Button variant="outline" size="sm" disabled={generating} onClick={() => generate("agent")}>
            {generating && <Spinner />}容器 Agent 生成
          </Button>
        </div>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        <Textarea rows={6} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如 feat: 新增功能" />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={busy || selected.size === 0 || !message.trim()} onClick={submit}>
            {busy && <Spinner />}提交 {selected.size} 个文件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 创建 Release：可编辑说明，并列出将执行的命令 */
export function ReleaseDialog({
  draft,
  commands,
  onSubmit,
  onCancel,
}: {
  draft: string
  commands: string[]
  onSubmit: (notes: string) => void
  onCancel: () => void
}) {
  const [notes, setNotes] = React.useState(draft)
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>创建 Release 草稿</DialogTitle>
          <DialogDescription>说明以模板开头，「更新内容」已按提交标题生成，可直接改。先创建草稿（不产生 tag、不会成为 latest），挂好安装包后再公开。</DialogDescription>
        </DialogHeader>
        <Textarea rows={14} value={notes} onChange={(event) => setNotes(event.target.value)} className="font-mono text-xs" />
        <Commands commands={commands} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!notes.trim()} onClick={() => onSubmit(notes)}>
            确认并创建草稿
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
