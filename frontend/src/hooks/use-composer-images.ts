import * as React from "react"

import {
  chatImageUrl,
  loadDraftImages,
  MAX_CHAT_IMAGES,
  saveDraftImages,
  uploadChatImage,
  validateChatImage,
} from "@/lib/chat-images"

export type ComposerImage = {
  id: string
  src: string
  status: "uploading" | "done" | "error"
  // 上传成功后的容器内路径
  path?: string
  error?: string
}

let nextId = 0

// 输入框里待发送的图片：选中 / 粘贴 / 拖进来时就开始上传，发送时只带路径。
// 路径存进本地草稿，刷新页面后还在（缩略图经 fs/raw 读）
export function useComposerImages(sessionName: string | null) {
  const [images, setImages] = React.useState<ComposerImage[]>([])
  const sessionRef = React.useRef(sessionName)
  const imagesRef = React.useRef<ComposerImage[]>([])

  const apply = React.useCallback((name: string | null, next: ComposerImage[], persist = true) => {
    imagesRef.current = next
    setImages(next)
    if (persist && name) saveDraftImages(name, next.filter((item) => item.path).map((item) => item.path as string))
  }, [])

  // 换会话：读回该会话草稿里的图片
  React.useEffect(() => {
    sessionRef.current = sessionName
    const restored: ComposerImage[] = sessionName
      ? loadDraftImages(sessionName).map((path) => ({ id: `img-${nextId++}`, src: chatImageUrl(sessionName, path), status: "done", path }))
      : []
    // eslint-disable-next-line react-hooks/set-state-in-effect
    apply(sessionName, restored, false)
  }, [sessionName, apply])

  const addFiles = React.useCallback(
    (files: File[]) => {
      const name = sessionRef.current
      if (!name || files.length === 0) return
      let next = imagesRef.current
      for (const file of files) {
        const id = `img-${nextId++}`
        const src = URL.createObjectURL(file)
        const reason = next.filter((item) => item.status !== "error").length >= MAX_CHAT_IMAGES ? `最多 ${MAX_CHAT_IMAGES} 张图片` : validateChatImage(file)
        if (reason) {
          next = [...next, { id, src, status: "error", error: reason }]
          continue
        }
        next = [...next, { id, src, status: "uploading" }]
        uploadChatImage(name, file).then(
          (path) => {
            if (sessionRef.current !== name) return
            apply(name, imagesRef.current.map((item) => (item.id === id ? { ...item, status: "done", path } : item)))
          },
          (error) => {
            if (sessionRef.current !== name) return
            apply(name, imagesRef.current.map((item) => (item.id === id ? { ...item, status: "error", error: error instanceof Error ? error.message : "上传失败" } : item)))
          }
        )
      }
      apply(name, next)
    },
    [apply]
  )

  const remove = React.useCallback(
    (id: string) => {
      apply(sessionRef.current, imagesRef.current.filter((item) => item.id !== id))
    },
    [apply]
  )

  // 发送后清空；restore 在发送没成功时把路径放回去
  const clear = React.useCallback(() => apply(sessionRef.current, []), [apply])
  const restore = React.useCallback(
    (paths: string[]) => {
      const name = sessionRef.current
      if (!name) return
      // 追加到已有的图片后面（输入框里的文字也是合并的），已经有的路径不重复加
      const have = new Set(imagesRef.current.map((item) => item.path))
      const added = paths.filter((path) => !have.has(path)).map((path) => ({ id: `img-${nextId++}`, src: chatImageUrl(name, path), status: "done" as const, path }))
      apply(name, [...imagesRef.current, ...added].slice(0, MAX_CHAT_IMAGES))
    },
    [apply]
  )

  const uploading = images.some((item) => item.status === "uploading")
  const paths = images.filter((item) => item.status === "done" && item.path).map((item) => item.path as string)
  return { images, addFiles, remove, clear, restore, uploading, paths }
}
