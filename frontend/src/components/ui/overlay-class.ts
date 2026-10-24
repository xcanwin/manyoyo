// 本地新增：Dialog / Sheet / AlertDialog 共用同一种遮罩（STYLE.md 第 9 节）。
// 模糊只放在遮罩上（弹层开着才存在），动画在 motion-reduce 下关闭。
export const OVERLAY_CLASS =
  "fixed inset-0 isolate z-50 bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none motion-reduce:duration-0"
