// 顶部卡片的文案与主按钮：还有下一步就引导下一步（Release 公开后验证 / npm 可能还没完成）；全部完成后引导“开始发布新版本”
type OverviewStatus = { version: string; published: boolean; pendingCommits: string[] }
type NextStage = { id: string; title: string; detail: string } | null | undefined

export type Overview = {
  title: string
  description: string
  primary: { kind: "version" | "stage"; label: string } | null
  showRunAll: boolean
  historyNote: string
}

export function buildOverview(status: OverviewStatus, next: NextStage): Overview {
  if (next) {
    return {
      title: `下一步：${next.title}`,
      description: next.detail,
      primary: { kind: "stage", label: `执行「${next.title}」` },
      showRunAll: true,
      historyNote: "",
    }
  }
  if (status.published) {
    const count = status.pendingCommits.length
    return {
      title: count ? `有 ${count} 个改动还没发布` : `v${status.version} 已发布 ✓`,
      description: count ? `先升版本号，再按步骤发布。当前已发布的是 v${status.version}。` : "还没有新的改动。",
      primary: count ? { kind: "version", label: "开始发布新版本" } : null,
      showRunAll: false,
      historyNote: `下面是 v${status.version} 的发布记录`,
    }
  }
  return { title: "全部完成", description: "所有阶段都已完成。", primary: null, showRunAll: false, historyNote: "" }
}
