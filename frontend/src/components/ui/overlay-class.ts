// 本地新增：Dialog / Sheet / AlertDialog 共用同一种遮罩（STYLE.md 第 9 节）。
// 模糊只放在遮罩上（弹层开着才存在），动画在 motion-reduce 下关闭。
// 淡出必须 fill-mode-forwards：默认播完 opacity 回到 1，面板还没卸载的那段时间整屏又以不透明模糊闪出来。
export const OVERLAY_CLASS =
  "fixed inset-0 isolate z-50 bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:fill-mode-forwards motion-reduce:animate-none motion-reduce:duration-0"
