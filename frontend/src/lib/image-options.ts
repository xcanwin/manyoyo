// 系统设置「基础」里镜像名 / 镜像版本联动用的纯函数。GET /api/images 返回本机已有镜像（新的在前）。
export type LocalImage = { name: string; tag: string; id: string; created: string; size: string }

export const DEFAULT_VERSION = "__default__"
export const CUSTOM_VERSION = "__custom__"

// 下拉里的镜像名候选：本机有的 + 默认的 + 配置里现在填的，去重
export function imageNameOptions(images: LocalImage[], defaultName: string, current: string): string[] {
  const names: string[] = []
  for (const name of [...images.map((item) => item.name), defaultName, current]) {
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

// 某个镜像名在本机有哪些版本（保持接口给的顺序）；名字留空表示用默认镜像名
export function versionsOf(images: LocalImage[], name: string, defaultName: string): LocalImage[] {
  const target = name || defaultName
  return images.filter((item) => item.name === target)
}

// 改了镜像名之后，版本要不要跟着换：
// - 输入的正好是本机已有的镜像：当前版本不属于它就换成它最新的版本（联动，避免“镜像名对、版本是别的镜像的”）；
// - 本机没有的名字（自己输入的、还没拉取）：不动。
// 返回要写入的新版本；undefined 表示不动
export function versionAfterNameChange(images: LocalImage[], nextName: string, currentVersion: string): string | undefined {
  if (!nextName) return undefined
  const tags = images.filter((item) => item.name === nextName)
  if (tags.length === 0) return undefined
  if (currentVersion && tags.some((item) => item.tag === currentVersion)) return undefined
  return tags[0].tag
}
