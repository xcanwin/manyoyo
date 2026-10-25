import { ImageIcon, XIcon } from "lucide-react"

import type { ComposerImage } from "@/hooks/use-composer-images"
import { Spinner } from "@/components/ui/spinner"
import { Hint } from "@/components/hint"

// 输入框上方的待发送图片：缩略图 + 删除；上传中转圈，失败在缩略图上写原因
export function ComposerImages({ images, onRemove }: { images: ComposerImage[]; onRemove: (id: string) => void }) {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-2" data-composer-images>
      {images.map((image) => (
        <div key={image.id} className="relative size-16 overflow-hidden rounded-lg border bg-muted" title={image.error || undefined}>
          {image.status === "error" ? (
            <div className="flex size-full flex-col items-center justify-center gap-0.5 p-1 text-center leading-tight text-destructive">
              <ImageIcon className="size-4" />
              <Hint className="line-clamp-2 text-destructive">{image.error}</Hint>
            </div>
          ) : (
            <img src={image.src} alt="待发送的图片" className="size-full object-cover" />
          )}
          {image.status === "uploading" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Spinner />
            </div>
          ) : null}
          <button
            type="button"
            aria-label="删除图片"
            title="删除图片"
            onClick={() => onRemove(image.id)}
            className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow hover:bg-background"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
