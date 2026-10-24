import { describe, expect, test } from "vitest"
// 用 Vite 的 ?raw 把源码当文本读进来（不依赖 node 类型）
const SOURCES = {
  ...import.meta.glob("./components/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("./hooks/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>

const FILES = Object.keys(SOURCES)
  .filter((key) => !key.includes("/ui/") && !key.endsWith(".test.tsx"))
  .sort()
const rel = (key: string) => key.replace(/^\.\//, "")

// 取出 <Tag ...> 的开标签文本（要数花括号，className 里的箭头函数 / 模板串可能带 >）
function openingTags(source: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?=[\\s>/])`, "g")
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    let depth = 0
    let i = match.index
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === "{") depth += 1
      else if (ch === "}") depth -= 1
      else if (ch === ">" && depth === 0) break
    }
    out.push(source.slice(match.index, i + 1))
  }
  return out
}

type Rule = {
  id: string
  describe: string
  count: (source: string, file: string) => number
}

const countMatches = (source: string, re: RegExp) =>
  (source.match(re) ?? []).length

const RULES: Rule[] = [
  {
    id: "dialog-size",
    describe:
      "DialogContent / SheetContent 只用 size 选档，不写 max-w-* / w-[..] / h-[..] / max-h-[..]",
    count: (source) =>
      ["DialogContent", "SheetContent"]
        .flatMap((tag) => openingTags(source, tag))
        .reduce(
          (n, tag) =>
            n +
            countMatches(
              tag,
              /(?<![\w-])(?:[\w:-]*:)?(?:max-w-|w-\[|h-\[|max-h-\[)/g
            ),
          0
        ),
  },
  {
    id: "raw-table",
    describe: "只读数据列表用 DataTable，不手写 <table>",
    count: (source, file) =>
      file.endsWith("components/data-table.tsx")
        ? 0
        : countMatches(source, /<table[\s>]/g),
  },
  {
    id: "raw-color",
    describe: "只用语义 token，不写原色",
    count: (source) =>
      countMatches(
        source,
        /(?<![\w-])(?:[\w:-]*:)?(?:text|bg|border|ring)-(?:red|green|emerald|amber|yellow|blue|orange|sky|lime|rose)-\d/g
      ),
  },
  {
    id: "font",
    describe:
      "界面字号字重走组件默认值，调用处不写 text-xs / text-sm / text-base / text-[..] / font-medium / font-semibold",
    count: (source) =>
      countMatches(
        source,
        /(?<![\w-])(?:[\w:-]*:)?(?:text-xs|text-sm|text-base|font-medium|font-semibold)(?![\w-])/g
      ) + countMatches(source, /(?<![\w-])(?:[\w:-]*:)?text-\[\d/g),
  },
  {
    id: "space",
    describe: "用 flex / grid + gap-*，不用 space-x-* / space-y-*",
    count: (source) =>
      countMatches(source, /(?<![\w-])(?:[\w:-]*:)?space-[xy]-/g),
  },
]

type Allow = Record<string, Record<string, [number, string]>>

// 文件 → 规则 → [允许次数, 理由]
const ALLOW: Allow = {
  "components/agent-instructions-panel.tsx": { font: [1, "待修（现状）"] },
  "components/agent-template-dialog.tsx": {
    "dialog-size": [1, "待修（现状）"],
    font: [1, "待修（现状）"],
  },
  "components/app-sidebar.tsx": {
    "dialog-size": [1, "待修（现状）"],
    font: [15, "待修（现状）"],
    "raw-color": [2, "待修（现状）"],
  },
  "components/basic-settings.tsx": { font: [3, "待修（现状）"] },
  "components/capacity-estimate-view.tsx": {
    font: [6, "待修（现状）"],
    space: [1, "待修（现状）"],
  },
  "components/changes-panel.tsx": {
    font: [9, "待修（现状）"],
    "raw-color": [4, "待修（现状）"],
  },
  "components/clone-name-dialog.tsx": { "dialog-size": [1, "待修（现状）"] },
  "components/composer-images.tsx": { font: [1, "待修（现状）"] },
  "components/composer-suggestions.tsx": { font: [3, "待修（现状）"] },
  "components/container-manage/container-manage-panel.tsx": {
    font: [13, "待修（现状）"],
  },
  "components/container-manage/denied-list.tsx": { font: [5, "待修（现状）"] },
  "components/container-manage/env-editor.tsx": { font: [4, "待修（现状）"] },
  "components/container-manage/network-editor.tsx": {
    font: [2, "待修（现状）"],
  },
  "components/container-manage/row-list.tsx": { font: [1, "待修（现状）"] },
  "components/container-manage/rule-table.tsx": {
    font: [8, "待修（现状）"],
    "raw-color": [2, "待修（现状）"],
  },
  "components/container-manage/target-input.tsx": { font: [6, "待修（现状）"] },
  "components/create-container-dialog.tsx": {
    "dialog-size": [3, "待修（现状）"],
    font: [4, "待修（现状）"],
  },
  "components/data-table.tsx": { font: [2, "待修（现状）"] },
  "components/directory-picker-dialog.tsx": {
    "dialog-size": [2, "待修（现状）"],
    font: [3, "待修（现状）"],
  },
  "components/doctor-panel.tsx": {
    font: [5, "待修（现状）"],
    "raw-color": [4, "待修（现状）"],
  },
  "components/files-panel.tsx": { font: [14, "待修（现状）"] },
  "components/hint.tsx": { font: [1, "待修（现状）"] },
  "components/html-preview-panel.tsx": { "dialog-size": [1, "待修（现状）"] },
  "components/key-value-list.tsx": { font: [3, "待修（现状）"] },
  "components/login-page.tsx": {
    font: [5, "待修（现状）"],
    "raw-color": [2, "待修（现状）"],
  },
  "components/logs-dialog.tsx": {
    "dialog-size": [3, "待修（现状）"],
    font: [8, "待修（现状）"],
  },
  "components/markdown-content.tsx": { "dialog-size": [1, "待修（现状）"] },
  "components/mirror-panel.tsx": { font: [1, "待修（现状）"] },
  "components/mirror-settings.tsx": { font: [1, "待修（现状）"] },
  "components/model-menu.tsx": { font: [1, "待修（现状）"] },
  "components/model-services-panel.tsx": {
    "dialog-size": [4, "待修（现状）"],
    font: [17, "待修（现状）"],
    "raw-color": [2, "待修（现状）"],
  },
  "components/orphan-states-panel.tsx": { font: [5, "待修（现状）"] },
  "components/page-header.tsx": { font: [5, "待修（现状）"] },
  "components/prompt-dialog.tsx": { "dialog-size": [1, "待修（现状）"] },
  "components/queued-prompts.tsx": { font: [3, "待修（现状）"] },
  "components/quick-chat-settings-view.tsx": { font: [7, "待修（现状）"] },
  "components/quick-chat-setup-dialog.tsx": {
    "dialog-size": [1, "待修（现状）"],
    font: [2, "待修（现状）"],
  },
  "components/rewind-dialog.tsx": {
    "dialog-size": [1, "待修（现状）"],
    font: [2, "待修（现状）"],
  },
  "components/search-dialog.tsx": {
    "dialog-size": [1, "待修（现状）"],
    font: [2, "待修（现状）"],
  },
  "components/setup-wizard.tsx": {
    font: [13, "待修（现状）"],
    "raw-color": [6, "待修（现状）"],
  },
  "components/storage-browser-dialog.tsx": {
    "dialog-size": [2, "待修（现状）"],
    font: [7, "待修（现状）"],
  },
  "components/storage-panel.tsx": {
    font: [11, "待修（现状）"],
    "raw-table": [2, "待修（现状）"],
  },
  "components/system-settings-dialog.tsx": {
    "dialog-size": [4, "待修（现状）"],
    font: [14, "待修（现状）"],
  },
  "components/terminal-view.tsx": { font: [10, "待修（现状）"] },
  "components/trace-block.tsx": { font: [18, "待修（现状）"] },
  "components/update-banner.tsx": { font: [1, "待修（现状）"] },
  "components/workspace-panel.tsx": { font: [19, "待修（现状）"] },
  "hooks/use-confirm-dialog.tsx": { "dialog-size": [1, "待修（现状）"] },
  "hooks/use-unsaved-changes-dialog.tsx": {
    "dialog-size": [1, "待修（现状）"],
  },
}

describe("style guard", () => {
  const counts: Record<string, Record<string, number>> = {}
  for (const file of FILES) {
    const source = SOURCES[file]
    for (const rule of RULES) {
      const n = rule.count(source, rel(file))
      if (n > 0) (counts[rel(file)] ||= {})[rule.id] = n
    }
  }

  for (const rule of RULES) {
    test(rule.describe, () => {
      const over = Object.entries(counts)
        .map(([file, byRule]) => ({
          file,
          n: byRule[rule.id] ?? 0,
          allowed: ALLOW[file]?.[rule.id]?.[0] ?? 0,
        }))
        .filter((item) => item.n > item.allowed)
        .map((item) => `${item.file}: ${item.n} 处（允许 ${item.allowed}）`)
      expect(over).toEqual([])
    })
  }

  test("白名单必须有理由，且不能比实际多（改完要调小）", () => {
    const stale: string[] = []
    for (const [file, byRule] of Object.entries(ALLOW)) {
      for (const [id, [allowed, reason]] of Object.entries(byRule)) {
        if (!reason.trim()) stale.push(`${file} ${id}: 缺理由`)
        if (allowed > (counts[file]?.[id] ?? 0))
          stale.push(
            `${file} ${id}: 白名单 ${allowed}，实际 ${counts[file]?.[id] ?? 0}`
          )
      }
    }
    expect(stale).toEqual([])
  })
})
