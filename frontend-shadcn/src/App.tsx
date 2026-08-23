import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { WorkspacePanel } from "@/components/workspace-panel"
import { useSessions } from "@/hooks/use-sessions"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import type { SessionSummary } from "@/lib/api"

export function App() {
  const { sessions, containers, loading, error, refresh } = useSessions()
  const [activeSessionName, setActiveSessionName] = React.useState<string | null>(null)

  // 从最新的 sessions 派生，而不是保存一份静态快照——
  // 这样改模型/CLI/备注之后只要刷新过列表，各处显示的都是最新数据
  const activeSession = React.useMemo(
    () => sessions.find((s) => s.name === activeSessionName) ?? null,
    [sessions, activeSessionName]
  )

  function handleSelectSession(session: SessionSummary | null) {
    setActiveSessionName(session ? session.name : null)
  }

  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
    >
      <AppSidebar
        containers={containers}
        loading={loading}
        error={error}
        activeSessionName={activeSessionName}
        onSelectSession={handleSelectSession}
        onRefresh={refresh}
      />
      <SidebarInset className="min-h-0">
        <WorkspacePanel activeSession={activeSession} onAfterSend={refresh} />
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
