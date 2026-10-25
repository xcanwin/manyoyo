import { XIcon } from "lucide-react"

import { Hint } from "@/components/hint"
import { MarkdownContent } from "@/components/markdown-content"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { SideQuestionState } from "@/hooks/use-side-question"

// 输入框上方的侧问浮层：问题、答案（markdown）、关闭。不进对话记录
export function SideAnswer({
  state,
  onClose,
  sessionName,
  baseDir,
}: {
  state: SideQuestionState
  onClose: () => void
  sessionName: string
  baseDir: string
}) {
  return (
    <div className="mx-3 mb-1 flex max-h-[40vh] flex-col gap-2 overflow-y-auto rounded-xl border bg-muted/40 p-3" role="region" aria-label="侧问">
      <div className="flex items-start gap-2">
        <Hint className="min-w-0 flex-1 break-words">侧问：{state.question}</Hint>
        <Button
          variant="ghost"
          size="icon-xs"
          className="touch-hit shrink-0"
          aria-label="关闭侧问"
          title={state.status === "loading" ? "取消并关闭" : "关闭"}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {state.status === "loading" ? (
        <div className="flex items-center gap-2">
          <Spinner />
          <Hint>正在回答，主任务不受影响…</Hint>
        </div>
      ) : state.status === "error" ? (
        <Hint className="text-destructive">{state.error}</Hint>
      ) : (
        <MarkdownContent content={state.answer} sessionName={sessionName} baseDir={baseDir} />
      )}
    </div>
  )
}
