// 样式守卫的规则与计数：src/style-guard.test.ts（检查）和 scripts/guard-sync.mjs（刷新白名单）共用
// 规则文字见 STYLE.md 第 2、3、4、8 节

// 取出 <Tag ...> 的开标签文本（要数花括号，className 里的箭头函数 / 模板串可能带 >）
export function openingTags(source, tag) {
  const out = []
  const re = new RegExp(`<${tag}(?=[\\s>/])`, "g")
  let match
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

const countMatches = (source, re) => (source.match(re) ?? []).length

export const RULES = [
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
    id: "leading",
    describe:
      "调用处不写 leading-*（混排行的 leading-none 除外，STYLE.md 第 12 节）",
    count: (source) =>
      countMatches(
        source,
        /(?<![\w-])(?:[\w:-]*:)?leading-(?!none(?![\w-]))/g
      ),
  },
  {
    id: "dark-color",
    describe: "不写 dark: 颜色覆盖，暗色靠语义 token 自动切换",
    count: (source) =>
      countMatches(
        source,
        /(?<![\w-])(?:[\w:-]*:)?dark:(?:[\w:-]*:)?(?:text|bg|border|ring|fill|stroke)-/g
      ),
  },
  {
    id: "hover-weak",
    describe:
      "悬停底色至少 /70（亮色主题下才有 0.03 以上的亮度差，STYLE.md 第 3 节）",
    count: (source) =>
      countMatches(
        source,
        /hover:bg-(?:muted|accent|secondary)\/(?:[0-6]\d|\d)(?!\d)/g
      ),
  },
  {
    id: "space",
    describe: "用 flex / grid + gap-*，不用 space-x-* / space-y-*",
    count: (source) =>
      countMatches(source, /(?<![\w-])(?:[\w:-]*:)?space-[xy]-/g),
  },
]
