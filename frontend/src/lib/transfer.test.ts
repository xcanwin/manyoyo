import { afterEach, describe, expect, test, vi } from "vitest"

import {
  confirmFromChecked,
  estimateTotal,
  friendlyError,
  importDropLines,
  itemsOfTier,
  matchTier,
  autoDownloadOnce,
  riskItems,
  statusLabel,
  uploadImportFile,
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

describe("容器状态与错误文案", () => {
  test("statusLabel 认出暂停（docker 与 podman 写法）、忙碌、仅历史", () => {
    expect(statusLabel("Up 3 hours (Paused)")).toBe("已暂停")
    expect(statusLabel("Paused")).toBe("已暂停")
    expect(statusLabel("paused")).toBe("已暂停")
    expect(statusLabel("Up 1 hour")).toBe("运行中")
    expect(statusLabel("running")).toBe("运行中")
    expect(statusLabel("busy")).toBe("正在导出 / 导入")
    expect(statusLabel("history")).toBe("仅历史")
    expect(statusLabel("Exited (0) 2 hours ago")).toBe("已停止")
  })

  test("底层连接错误换成一句人话，其余原样", () => {
    expect(friendlyError("Premature close")).toBe("连接中断了，请重试")
    expect(friendlyError("EBADF: bad file descriptor")).toBe("连接中断了，请重试")
    expect(friendlyError("容器名已存在")).toBe("容器名已存在")
    expect(friendlyError("", "导入失败")).toBe("导入失败")
  })

  test("importDropLines：每个容器的丢弃项与系统层各一条", () => {
    expect(importDropLines(null)).toEqual([])
    expect(importDropLines({ details: [{ name: "a", dropped: [], layerSkippedSystem: 0 }] })).toEqual([])
    expect(importDropLines({ details: [{ name: "a", dropped: ["x", "y"], layerSkippedSystem: 2 }] })).toEqual([
      "a：x", "a：y", "a：用了默认镜像，2 个系统层文件没有还原",
    ])
  })
})

describe("uploadImportFile 经反向代理超时", () => {
  function fakeXhr(status: number, body: string) {
    class Xhr {
      upload = { onprogress: null as unknown }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      status = status
      responseText = body
      open() {}
      setRequestHeader() {}
      send() { queueMicrotask(() => this.onload?.()) }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", Xhr)
  }
  afterEach(() => vi.unstubAllGlobals())

  test("502 / 504：服务端任务还在跑，不当成失败，沿用登记时的任务号", async () => {
    fakeXhr(504, "<html>504 Gateway Time-out</html>")
    await expect(uploadImportFile(new File(["x"], "a"), "/api/imports/j9/upload", () => {}, "j9").promise).resolves.toEqual({ jobId: "j9" })
    fakeXhr(502, "")
    await expect(uploadImportFile(new File(["x"], "a"), "/api/imports/j9/upload", () => {}, "j9").promise).resolves.toEqual({ jobId: "j9" })
  })

  test("没有任务号时 504 仍是失败；400 之类的错误照常报", async () => {
    fakeXhr(504, "")
    await expect(uploadImportFile(new File(["x"], "a"), "/api/imports/j9/upload", () => {}).promise).rejects.toThrow()
    fakeXhr(400, JSON.stringify({ error: "不是 manyoyo 导出文件" }))
    await expect(uploadImportFile(new File(["x"], "a"), "/api/imports/j9/upload", () => {}, "j9").promise).rejects.toThrow("不是 manyoyo 导出文件")
  })
})

describe("autoDownloadOnce", () => {
  afterEach(() => vi.restoreAllMocks())

  test("每个任务只自动触发一次（进度弹窗和侧栏都会看到 ready，下载链接只能用一次）", () => {
    const clicks: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.getAttribute("href") || "")
    })
    expect(autoDownloadOnce("job-a", "/api/exports/job-a/download")).toBe(true)
    expect(autoDownloadOnce("job-a", "/api/exports/job-a/download")).toBe(false)
    expect(autoDownloadOnce("job-b", "/api/exports/job-b/download")).toBe(true)
    expect(autoDownloadOnce("job-c", "")).toBe(false)
    expect(clicks).toEqual(["/api/exports/job-a/download", "/api/exports/job-b/download"])
  })
})
