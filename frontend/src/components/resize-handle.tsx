import { cn } from "@/lib/utils"

export function ResizeHandle({
  onPointerDown,
  dragging,
  className,
  style,
}: {
  onPointerDown: (event: React.PointerEvent) => void
  dragging: boolean
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      style={style}
      className={cn("group relative w-2 shrink-0 cursor-col-resize touch-none select-none", className)}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/60",
          dragging && "bg-primary"
        )}
      />
    </div>
  )
}
