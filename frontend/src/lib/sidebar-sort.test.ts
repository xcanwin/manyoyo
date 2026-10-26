import { beforeEach, describe, expect, test } from "vitest"

import type { ContainerGroup, SessionSummary } from "@/lib/api"
import {
  DEFAULT_SIDEBAR_SORT,
  SIDEBAR_SORT_STORAGE_KEY,
  loadSidebarSort,
  saveSidebarSort,
  sortAgentSessions,
  sortContainerGroups,
} from "./sidebar-sort"

const group = (over: Partial<ContainerGroup> & { containerName: string }): ContainerGroup => ({
  containerRemark: "",
  status: "Up",
  image: "",
  hostPath: "",
  updatedAt: "",
  sessions: [],
  ...over,
})
const agent = (over: Partial<SessionSummary> & { name: string }): SessionSummary =>
  ({ agentId: "x", agentName: "AGENT", agentRemark: "", containerName: "c", createdAt: null, updatedAt: null, ...over }) as SessionSummary

describe("容器排序", () => {
  const groups = [
    group({ containerName: "b-box", containerRemark: "乙", updatedAt: "2026-10-02T00:00:00Z", containerCreatedAt: "2026-09-01T00:00:00Z" }),
    group({ containerName: "a-box", containerRemark: "甲", updatedAt: "2026-10-03T00:00:00Z", containerCreatedAt: "2026-09-03T00:00:00Z" }),
    group({ containerName: "c-box", containerRemark: "丙", updatedAt: "2026-10-01T00:00:00Z", containerCreatedAt: "2026-09-02T00:00:00Z" }),
  ]
  const names = (key: "name" | "created" | "updated", list = groups) => sortContainerGroups(list, key).map((g) => g.containerName)

  test("按修改时间、创建时间都是新的在前；按名称用备注优先、中文排序", () => {
    expect(names("updated")).toEqual(["a-box", "b-box", "c-box"])
    expect(names("created")).toEqual(["a-box", "c-box", "b-box"])
    // 拼音序：丙 bing < 甲 jia < 乙 yi
    expect(names("name")).toEqual(["c-box", "a-box", "b-box"])
  })
  test("置顶的容器始终在最前，不受排序影响", () => {
    const list = [...groups, group({ containerName: "pin", pinned: true })]
    for (const key of ["name", "created", "updated"] as const) expect(names(key, list)[0]).toBe("pin")
  })
  test("仅剩历史的容器没有创建时间，退回组内最早的 AGENT 创建时间", () => {
    const list = [
      group({ containerName: "h1", status: "history", sessions: [agent({ name: "h1", createdAt: "2026-09-10T00:00:00Z" }), agent({ name: "h1~2", createdAt: "2026-09-20T00:00:00Z" })] }),
      group({ containerName: "h2", status: "history", sessions: [agent({ name: "h2", createdAt: "2026-09-15T00:00:00Z" })] }),
      group({ containerName: "none", status: "history" }),
    ]
    expect(names("created", list)).toEqual(["h2", "h1", "none"])
  })
  test("不改原数组", () => {
    const before = groups.map((g) => g.containerName)
    sortContainerGroups(groups, "name")
    expect(groups.map((g) => g.containerName)).toEqual(before)
  })
})

describe("AGENT 排序", () => {
  const sessions = [
    agent({ name: "1", agentRemark: "乙", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }),
    agent({ name: "2", agentRemark: "甲", createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" }),
    agent({ name: "3", agentRemark: "丙", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", pinned: true }),
  ]
  test("置顶在最前，其余按所选方式", () => {
    expect(sortAgentSessions(sessions, "updated").map((s) => s.name)).toEqual(["3", "1", "2"])
    expect(sortAgentSessions(sessions, "created").map((s) => s.name)).toEqual(["3", "2", "1"])
    expect(sortAgentSessions(sessions, "name").map((s) => s.name)).toEqual(["3", "2", "1"])
  })
})

describe("排序偏好", () => {
  beforeEach(() => window.localStorage.clear())
  test("读写往返；缺失、损坏、非法值都退回默认（修改时间）", () => {
    expect(loadSidebarSort()).toEqual(DEFAULT_SIDEBAR_SORT)
    saveSidebarSort({ containers: "name", agents: "created" })
    expect(loadSidebarSort()).toEqual({ containers: "name", agents: "created" })
    window.localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, "{坏的")
    expect(loadSidebarSort()).toEqual(DEFAULT_SIDEBAR_SORT)
    window.localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, JSON.stringify({ containers: "x", agents: "name" }))
    expect(loadSidebarSort()).toEqual({ containers: "updated", agents: "name" })
  })
})
