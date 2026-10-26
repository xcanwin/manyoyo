import { describe, expect, test } from "vitest"

import {
  confirmFromChecked,
  estimateTotal,
  itemsOfTier,
  matchTier,
  riskItems,
  type ImportContainer,
  type TransferItem,
  type TransferTier,
} from "./transfer"

const tiers: TransferTier[] = [{ id: "light", label: "轻量" }, { id: "standard", label: "标准" }, { id: "full", label: "完整" }]
const item = (id: string, t: string[]): TransferItem => ({ id, label: id, hint: "", tiers: t })
const items = [
  item("history", ["light", "standard", "full"]),
  item("uploads", ["standard", "full"]),
  item("systemLayer", ["full"]),
]

describe("档位与内容项", () => {
  test("点档位 = 勾选该档的内容；手动改动后正好等于某档就高亮那档，否则自定义", () => {
    expect(itemsOfTier(items, "light")).toEqual(["history"])
    expect(itemsOfTier(items, "standard")).toEqual(["history", "uploads"])
    expect(matchTier(items, tiers, ["history", "uploads"])).toBe("standard")
    expect(matchTier(items, tiers, ["uploads", "history"])).toBe("standard")
    expect(matchTier(items, tiers, ["history", "systemLayer"])).toBe("custom")
    expect(matchTier(items, tiers, [])).toBe("custom")
  })

  test("估算合计：有一项未知就标未知，已知的照加", () => {
    expect(estimateTotal({ history: 10, uploads: 20, systemLayer: null }, ["history", "uploads"])).toEqual({ bytes: 30, unknown: false })
    expect(estimateTotal({ history: 10, systemLayer: null }, ["history", "systemLayer"])).toEqual({ bytes: 10, unknown: true })
  })
})

describe("导入时的风险确认", () => {
  const container = {
    idx: 0, name: "a", risks: { containerMode: "sock", volumes: ["/:/host", "/d:/data"], ports: ["80:80"], autostart: true, envFiles: ["/home/u/.env"], networkOpen: true },
  } as unknown as ImportContainer

  test("每个高风险设置一项，没勾的不会出现在确认里", () => {
    expect(riskItems(container).map((r) => r.key)).toEqual(["mode:sock", "volume:/:/host", "volume:/d:/data", "ports", "autostart", "envfile:/home/u/.env", "networkOpen"])
    expect(confirmFromChecked(container, new Set())).toEqual({ containerMode: undefined, volumes: [], ports: false, autostart: false, envFiles: [], networkOpen: false })
    expect(confirmFromChecked(container, new Set(["mode:sock", "volume:/d:/data", "autostart", "envfile:/home/u/.env"]))).toEqual({
      containerMode: "sock", volumes: ["/d:/data"], ports: false, autostart: true, envFiles: ["/home/u/.env"], networkOpen: false,
    })
    expect(riskItems({ idx: 1, name: "b", risks: {} } as unknown as ImportContainer)).toEqual([])
  })
})
