import { PencilIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { QUEUE_WHEN_BADGES, type QueueItem } from "@/lib/queue"

// 消息流底部的“排队中”提示词：气泡样式沿用用户气泡，加淡色角标和取消 / 编辑；
// 没有任务在跑、队列还有内容（比如用户点了停止）时，给一个“继续发送”
export function QueuedPrompts({
  items,
  idle,
  onCancel,
  onEdit,
  onContinue,
}: {
  items: QueueItem[]
  idle: boolean
  onCancel: (item: QueueItem) => void
  onEdit: (item: QueueItem) => void
  onContinue: () => void
}) {
  if (!items.length) return null
  return (
    <div data-queued-prompts className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.id} data-queued-item className="flex flex-col items-end gap-1">
          <div className="max-w-[88%] rounded-xl border border-dashed bg-muted/40 px-3 py-2 text-sm leading-[1.75] whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere] @3xl:max-w-[75%]">
            {item.text}
          </div>
          {/* 编辑 = 撤回后把文字放回输入框；撤回 = 直接取消这一条 */}
          <span className="flex items-center gap-0.5 px-1 text-xs text-muted-foreground">
            <span className="mr-1">排队中 · {QUEUE_WHEN_BADGES[item.when]}</span>
            <Button variant="ghost" size="icon" aria-label="编辑" title="编辑（放回输入框）" onClick={() => onEdit(item)}>
              <PencilIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label="撤回" title="撤回" onClick={() => onCancel(item)}>
              <XIcon />
            </Button>
          </span>
        </div>
      ))}
      {idle ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>已停止，排队中的提示词还在，可以取消或继续</span>
          <Button size="xs" variant="outline" onClick={onContinue}>
            继续发送
          </Button>
        </div>
      ) : null}
    </div>
  )
}
