import { describe, expect, test } from "vitest"

import dataTable from "./components/data-table.tsx?raw"
import ruleTable from "./components/container-manage/rule-table.tsx?raw"
import workspace from "./components/workspace-panel.tsx?raw"

// 手机上嵌在文字行 / 表格行里的小图标按钮要有 40px 点击区域（STYLE.md 第 12 节）。
// 真实的命中测量是 Playwright 在 390 宽下做的（见 FEEDBACK3）；这里只守住“用到了该用的地方”（vitest 不读 CSS，工具类本身的效果以 Playwright 为准）。
describe("touch-hit", () => {
  test("DataTable 手机卡片、规则表、消息行的回退按钮都在用", () => {
    expect(dataTable).toContain("[&_[data-slot=button]]:touch-hit")
    expect(ruleTable.match(/className="touch-hit"/g)?.length).toBe(4)
    expect(workspace).toMatch(/size="icon-xs" className="touch-hit" aria-label="回退到这里"/)
  })
  test("相邻按钮之间留够间距，点击区域不重叠", () => {
    expect(dataTable).toContain("gap-3 [&_[data-slot=button]]:touch-hit")
    expect(ruleTable).toContain("max-md:gap-3")
  })
})
