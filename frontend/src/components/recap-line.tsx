import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Hint } from "@/components/hint"

// 消息流底部的一行回顾（灰色辅助档）；关闭只是本次隐藏
export function RecapLine({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 px-4 py-1" data-testid="recap-line">
      <Hint className="min-w-0 flex-1 break-words">回顾：{text}</Hint>
      <Button
        variant="ghost"
        size="icon-xs"
        className="touch-hit shrink-0"
        aria-label="关闭回顾"
        title="关闭回顾"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  )
}
