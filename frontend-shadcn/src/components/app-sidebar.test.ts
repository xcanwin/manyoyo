import { describe, expect, test } from "vitest"

import { pickDefaultSessionForContainer } from "./app-sidebar"
import type { SessionSummary } from "@/lib/api"

// 回归用例：点击侧边栏"容器"行时（goToAgents 只切 UI 导航层级，不会自动
// 触发 selectSession），主聊天区曾经完全不会切换到新容器——面包屑/侧边栏
// 高亮已经变了，但 activeSessionName 还停在旧会话，/messages、/detail 请求
// 都不会为新容器发出。pickDefaultSessionForContainer 用于在 goToAgents 之后
// 算出该跟着自动选中哪个 session，交给 selectSession 补上这一步。
function buildSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name: "c1",
    containerName: "c1",
    agentId: "default",
    agentName: "AGENT 1",
    agentRemark: "",
    containerRemark: "",
    status: "running",
    image: "",
    createdAt: null,
    updatedAt: null,
    messageCount: 0,
    agentEnabled: true,
    agentProgram: "claude",
    resumeSupported: true,
    model: "",
    hostPath: "",
    containerPath: "",
    ...overrides,
  }
}

describe("pickDefaultSessionForContainer", () => {
  test("当前激活会话就属于这个容器时，保持原选中不变", () => {
    const sessions = [
      buildSession({ name: "c1", agentId: "default" }),
      buildSession({ name: "c1~agent-2", agentId: "agent-2" }),
    ]
    const picked = pickDefaultSessionForContainer(sessions, "c1~agent-2")
    expect(picked?.name).toBe("c1~agent-2")
  })

  test("切到别的容器时，默认选第一个非 synthetic 的真实 AGENT", () => {
    const sessions = [
      buildSession({ name: "c2", agentId: "default", synthetic: true }),
      buildSession({ name: "c2~agent-2", agentId: "agent-2" }),
    ]
    const picked = pickDefaultSessionForContainer(sessions, "other-container~default")
    expect(picked?.name).toBe("c2~agent-2")
  })

  test("容器下只有 synthetic 占位（从没真正对话过）时，退回选中这个占位", () => {
    const sessions = [buildSession({ name: "c3", agentId: "default", synthetic: true })]
    const picked = pickDefaultSessionForContainer(sessions, null)
    expect(picked?.name).toBe("c3")
  })

  test("容器没有任何 session 时返回 null", () => {
    expect(pickDefaultSessionForContainer([], null)).toBeNull()
  })
})
