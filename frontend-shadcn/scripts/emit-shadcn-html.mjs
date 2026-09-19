import { copyFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, "..", "dist", "index.html")
const dest = path.join(here, "..", "..", "lib", "web", "frontend", "shadcn.html")

// lib/web/frontend/ 里现在只剩这个构建产物，而它是 .gitignore 掉的——git 不跟踪空
// 目录，全新检出（CI、别人第一次 clone）根本没有这个目录，直接 copyFileSync 会 ENOENT
mkdirSync(path.dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`已生成 ${path.relative(process.cwd(), dest)}`)
