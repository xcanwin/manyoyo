import { describe, expect, test } from "vitest"

import { RULES } from "../scripts/guard-rules.mjs"
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

type Allow = Record<string, Record<string, [number, string]>>

// 文件 → 规则 → [允许次数, 理由]
const ALLOW: Allow = {
  "components/app-sidebar.tsx": { "font": [2, "品牌名 “MANYOYO Web”，不属于界面字档位"] },
  "components/changes-panel.tsx": { "font": [1, "内容区：diff 行"], "leading": [1, "内容区：diff 行高"] },
  "components/code-block.tsx": { "font": [1, "内容区：等宽预格式文本（原始报错 / 日志 / 提示词原文）"] },
  "components/column-header.tsx": { "font": [2, "定义可编辑行表头（12px 黑色加粗）本身"] },
  "components/composer-images.tsx": { "leading": [1, "图片失败占位的小字，行高紧凑；待改成组件档位"] },
  "components/data-table.tsx": { "font": [1, "手机卡片里的辅助档标签（Hint 之外的 span 内联）"] },
  "components/files-panel.tsx": { "dark-color": [1, "路径条模仿 Input 的暗色底；待换成 Input 组件"] },
  "components/hint.tsx": { "font": [1, "定义“辅助档”本身（STYLE.md 第 2 节）"] },
  "components/html-preview-panel.tsx": { "dialog-size": [1, "侧板预览：Sheet 沿用现状的宽度与手机全屏写法（STYLE.md 第 8 节）"] },
  "components/key-value-list.tsx": { "font": [3, "定义“辅助档标签 + 正文值”本身"] },
  "components/login-page.tsx": { "font": [2, "整页：登录页标题可以更大（STYLE.md 第 14 节例外）"] },
  "components/page-header.tsx": { "font": [5, "定义“标题 / 区块标题 / 副标题”档本身"] },
  "components/queued-prompts.tsx": { "font": [1, "排队中的提示词气泡，与聊天气泡同样式（内容区）"], "leading": [1, "内容区：与聊天气泡同行高"] },
  "components/search-dialog.tsx": { "dialog-size": [1, "命令面板：shadcn Command 的标准结构（STYLE.md 第 14 节例外）"], "font": [2, "命令面板：shadcn Command 的标准结构（STYLE.md 第 14 节例外）"] },
  "components/section-toggle.tsx": { "font": [2, "定义折叠区标题（区块标题档）本身"] },
  "components/setup-wizard.tsx": { "font": [1, "整页：向导标题可以更大（STYLE.md 第 14 节例外）"] },
  "components/system-settings-dialog.tsx": { "dark-color": [1, "覆盖 Tabs 在暗色下的文字色；待改成组件 variant"] },
  "components/trace-block.tsx": { "font": [18, "内容区：执行过程（trace-block 的数值，STYLE.md 第 2 节登记）"], "leading": [3, "内容区：执行过程（NARRATION_TEXT 与代码块行高）"] },
  "components/workspace-panel.tsx": { "dark-color": [1, "覆盖 Textarea 的暗色底（输入框嵌在 Composer 圆角框里）；待改成组件 variant"], "font": [4, "聊天气泡与代码块是内容区；顶栏标题是区块标题档（顶栏是自定义布局，不能用 PageHeader）"], "leading": [2, "内容区：聊天气泡行高"] },
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
