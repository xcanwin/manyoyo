import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Hint } from "@/components/hint"
import { IMAGE_PROBLEM_EVENT } from "@/lib/api"

export type ImageProblem = {
  code: string
  imageRef: string
  runtimeLabel: string
  pullCommand: string
  buildCommand: string
}

function isImageProblem(value: unknown): value is ImageProblem {
  const item = value as Partial<ImageProblem> | null
  return Boolean(item && typeof item.imageRef === "string" && typeof item.pullCommand === "string" && typeof item.buildCommand === "string")
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
      <code className="min-w-0 flex-1 font-mono break-all">{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="复制命令"
        title="复制命令"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true))
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

// 镜像不存在 / 拉不到：用弹窗说清楚怎么办（比 toast 重要，不能一闪而过）。由 api.ts 在收到 imageProblem 时派发事件触发
export function ImageProblemDialog() {
  const [problem, setProblem] = React.useState<ImageProblem | null>(null)
  React.useEffect(() => {
    function onProblem(event: Event) {
      const detail = (event as CustomEvent).detail
      if (isImageProblem(detail)) setProblem(detail)
    }
    window.addEventListener(IMAGE_PROBLEM_EVENT, onProblem)
    return () => window.removeEventListener(IMAGE_PROBLEM_EVENT, onProblem)
  }, [])
  const notFound = problem?.code === "IMAGE_NOT_FOUND"
  return (
    <Dialog open={problem !== null} onOpenChange={(open) => (open ? null : setProblem(null))}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{notFound ? "本机没有这个镜像" : "镜像拉取失败"}</DialogTitle>
          <DialogDescription>
            {notFound
              ? "仓库里没有这个版本，或没有访问权限。"
              : "连不上镜像仓库，检查网络或代理后再试。"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {problem ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Hint>镜像</Hint>
                <CommandLine command={problem.imageRef} />
              </div>
              <div className="flex flex-col gap-2">
                <span>方法一：在终端里下载（当前用的是{problem.runtimeLabel}）</span>
                <CommandLine command={problem.pullCommand} />
              </div>
              <div className="flex flex-col gap-2">
                <span>方法二：本地构建</span>
                <CommandLine command={problem.buildCommand} />
              </div>
              <Hint>
                装好之后，也可以在「系统设置 → 基础」里把镜像版本改成本机已有的版本。
              </Hint>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setProblem(null)}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
