import { copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, "..", "dist-release", "release.html")
const dest = path.join(here, "..", "..", "scripts", "release", "console.html")

copyFileSync(src, dest)
console.log(`已生成 ${path.relative(process.cwd(), dest)}`)
