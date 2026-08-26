import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // 初值直接用 lazy initializer 算出来，不在 effect 里做一次性同步 setState；
  // effect 只保留订阅 matchMedia 变化这一个真正的外部系统副作用
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => window.innerWidth < MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
