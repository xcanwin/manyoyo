import * as React from "react"

// 聊天区的浮钮（“有新输出”“回复开头”）：一直显示会挡住正在读的内容，所以出现后 3 秒内逐渐淡出，然后不再显示。
// 淡出本身是 CSS 动画（index.css 的 pill-fade，FADE_MS 与它的时长一致），这里只管什么时候开始、什么时候移除：
// - 条件不成立：不显示；
// - poke()（用户又在滚动、方向变了）：条件仍成立时重新出现，cycle 加一，调用方用它当 key 让动画从头开始；
// - hold(true)（鼠标在按钮上移动、获得焦点、手指按下）：全显、不淡出，hold(false) 后从头淡出。
export const FADE_MS = 3000

export function useFadingPill(active: boolean) {
  const [visible, setVisible] = React.useState(active)
  const [holding, setHolding] = React.useState(false)
  const [cycle, setCycle] = React.useState(0)
  const timerRef = React.useRef(0)
  const holdingRef = React.useRef(false)
  const activeRef = React.useRef(active)

  const restart = React.useCallback((bump = true) => {
    window.clearTimeout(timerRef.current)
    if (!activeRef.current) {
      // 按钮被点掉后立刻隐藏，收不到“松开 / 离开”：在这里清掉按住状态，否则下次出现永远不淡出
      holdingRef.current = false
      setHolding(false)
      setVisible(false)
      return
    }
    setVisible(true)
    setHolding(holdingRef.current)
    // 松开手指（hold(false)）不换 key：换了 key 按钮节点被替换，手机上 pointerup 之后的 click 就落空，要点两次
    if (bump) setCycle((n) => n + 1)
    if (holdingRef.current) return
    timerRef.current = window.setTimeout(() => setVisible(false), FADE_MS)
  }, [])

  // 条件从不成立变成立时从头开始；变不成立时立即隐藏
  React.useEffect(() => {
    activeRef.current = active
    restart()
  }, [active, restart])

  React.useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const poke = React.useCallback(() => {
    if (activeRef.current) restart()
  }, [restart])

  const hold = React.useCallback(
    (on: boolean) => {
      if (holdingRef.current === on) return
      holdingRef.current = on
      if (!on) {
        restart(false)
        return
      }
      // 按住：只停掉计时、取消淡出，不换 cycle——换 key 会在按下和松开之间把按钮换掉，点击就不触发了
      window.clearTimeout(timerRef.current)
      if (activeRef.current) setHolding(true)
    },
    [restart]
  )

  return { visible, fading: visible && !holding, cycle, poke, hold }
}
