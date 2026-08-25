import * as React from "react"

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// VSCode 风格的水平拖拽调宽：宽度持久化到 localStorage，拖拽时用原生 pointer 事件
// 而不是受控 state 驱动 CSS transition，避免每次 mousemove 都触发过渡动画的抖动感
export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
}: {
  storageKey: string
  defaultWidth: number
  min: number
  max: number
}) {
  const [width, setWidth] = React.useState(() => {
    if (typeof window === "undefined") return defaultWidth
    const stored = Number(window.localStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : defaultWidth
  })
  const [dragging, setDragging] = React.useState(false)

  React.useEffect(() => {
    window.localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const onHandlePointerDown = React.useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      setDragging(true)

      function onMove(moveEvent: PointerEvent) {
        setWidth(clamp(startWidth + (moveEvent.clientX - startX), min, max))
      }
      function onUp() {
        setDragging(false)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [width, min, max]
  )

  return { width, dragging, onHandlePointerDown }
}
