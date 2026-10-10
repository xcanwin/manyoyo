import { cn } from "@/lib/utils"

// 只提供可拖拽的热区，不画任何线：左右两侧的面板本身都有边框，
// 再叠一根悬停 / 拖拽时变色的线，在手机横竖屏切换时会残留成一根多余的黑线
export function ResizeHandle({
  onPointerDown,
  className,
  style,
}: {
  onPointerDown: (event: React.PointerEvent) => void
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      style={style}
      className={cn("w-2 shrink-0 cursor-col-resize touch-none select-none", className)}
    />
  )
}
