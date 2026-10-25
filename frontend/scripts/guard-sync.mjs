// 用当前实际次数刷新 src/style-guard.test.ts 里的白名单（ALLOW）。
// 用法（在 frontend/ 下）：node scripts/guard-sync.mjs ["新条目的理由"]
//   - 只减不增：任何一项实际次数比白名单里的旧值大，直接失败，什么都不写；
//   - 次数降到 0 的条目自动删除；
//   - 白名单里原来没有的条目是新增违规，必须传理由才能写入（说明为什么是例外），否则失败。
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { RULES } from "./guard-rules.mjs"

const root = fileURLToPath(new URL("../src", import.meta.url))
const testFile = join(root, "style-guard.test.ts")
const newReason = process.argv[2]

function walk(dir, recursive) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      return recursive && entry.name !== "ui" ? walk(full, true) : []
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
      ? [full]
      : []
  })
}
// 与测试的扫描范围一致：components/**（不含 ui/）与 hooks/*.tsx
const files = [
  ...walk(join(root, "components"), true),
  ...walk(join(root, "hooks"), false),
].sort()

const counts = {}
for (const file of files) {
  const source = readFileSync(file, "utf8")
  const key = relative(root, file).split("\\").join("/")
  for (const rule of RULES) {
    const n = rule.count(source, key)
    if (n > 0) (counts[key] ||= {})[rule.id] = n
  }
}

const text = readFileSync(testFile, "utf8")
const block = text.match(/const ALLOW: Allow = \{\n([\s\S]*?)\n\}\n/)
if (!block) throw new Error("找不到 ALLOW 块")
const old = {}
for (const line of block[1].split("\n")) {
  const m = line.match(/^\s*"([^"]+)": \{(.*)\},?\s*$/)
  if (!m) continue
  old[m[1]] = {}
  for (const e of m[2].matchAll(/"([\w-]+)": \[(\d+), "([^"]*)"\]/g))
    old[m[1]][e[1]] = [Number(e[2]), e[3]]
}

const problems = []
const lines = []
for (const file of Object.keys(counts).sort()) {
  const parts = []
  for (const [id, n] of Object.entries(counts[file]).sort()) {
    const prev = old[file]?.[id]
    if (prev && n > prev[0])
      problems.push(`${file} ${id}: 白名单 ${prev[0]}，实际 ${n}（只减不增）`)
    if (!prev && !newReason)
      problems.push(`${file} ${id}: 新增违规 ${n} 处，没有白名单理由`)
    parts.push(`"${id}": [${n}, ${JSON.stringify(prev ? prev[1] : newReason ?? "")}]`)
  }
  lines.push(`  ${JSON.stringify(file)}: { ${parts.join(", ")} },`)
}
if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
writeFileSync(
  testFile,
  text.slice(0, block.index + block[0].indexOf(block[1])) +
    lines.join("\n") +
    text.slice(block.index + block[0].indexOf(block[1]) + block[1].length)
)
const total = {}
for (const byRule of Object.values(counts))
  for (const [id, n] of Object.entries(byRule)) total[id] = (total[id] ?? 0) + n
console.log("ok", total)
