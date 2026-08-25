import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"

export type HtmlPreviewState = {
  title: string
  code: string
} | null

// 沙箱化的 HTML 预览：只给 allow-scripts，不给 allow-same-origin——
// srcdoc 在这个组合下会得到一个和站点主源不同的 opaque origin，脚本访问不到
// 父页面的 cookie / localStorage，避免 Agent 生成的 html 片段变成 XSS 跳板
export function HtmlPreviewPanel({
  state,
  onOpenChange,
}: {
  state: HtmlPreviewState
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={state !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate">{state?.title || "HTML 预览"}</SheetTitle>
          <SheetDescription>沙箱环境渲染，无法访问站点数据</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 bg-white">
          {state ? (
            <iframe
              title={state.title || "html-preview"}
              srcDoc={state.code}
              sandbox="allow-scripts"
              className="size-full border-0"
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
