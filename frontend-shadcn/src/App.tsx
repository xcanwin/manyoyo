import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { ResizeHandle } from "@/components/resize-handle"
import { WorkspacePanel } from "@/components/workspace-panel"
import { useIsMobile } from "@/hooks/use-mobile"
import { useResizableWidth } from "@/hooks/use-resizable-width"
import { useSessions } from "@/hooks/use-sessions"
import { useUnsavedChangesDialog } from "@/hooks/use-unsaved-changes-dialog"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import type { FilesEditorState } from "@/components/files-panel"
import type { SessionSummary } from "@/lib/api"

export function App() {
  const { sessions, containers, loading, error, refresh } = useSessions()
  const isMobile = useIsMobile()
  const { width: sidebarWidth, dragging: sidebarDragging, onHandlePointerDown } = useResizableWidth({
    storageKey: "manyoyo:sidebar-width",
    defaultWidth: 288,
    min: 224,
    max: 512,
  })
  const [activeSessionName, setActiveSessionName] = React.useState<string | null>(null)
  // 提到 App 一级，容器列表下拉里的「新建 AGENT」和 agent 列表头部按钮共用同一个状态，
  // 右侧工作台也据此展示加载态，不只是侧栏按钮自己转圈
  const [creatingAgentContainer, setCreatingAgentContainer] = React.useState<string | null>(null)

  // 从最新的 sessions 派生，而不是保存一份静态快照——
  // 这样改模型/CLI/备注之后只要刷新过列表，各处显示的都是最新数据
  const activeSession = React.useMemo(
    () => sessions.find((s) => s.name === activeSessionName) ?? null,
    [sessions, activeSessionName]
  )

  // 文件管理编辑器的编辑状态用 ref 而不是 state 上提——每次按键都要更新，放进 state
  // 会一路重渲染到 App；ref 只在真正需要读取（切换 agent / 新建 agent / 切换顶部标签）
  // 的那一刻查询，值是 null（未编辑/无修改）或 { fileName, save }（有未保存修改）
  const filesEditorRef = React.useRef<FilesEditorState | null>(null)
  const { ask: askUnsavedChanges, dialog: unsavedChangesDialog } = useUnsavedChangesDialog()
  const confirmLeaveIfDirty = React.useCallback(async () => {
    const state = filesEditorRef.current
    if (!state) return true
    const result = await askUnsavedChanges(state.fileName, state.save)
    return result === "proceed"
  }, [askUnsavedChanges])

  function handleSelectSession(session: SessionSummary | null) {
    setActiveSessionName(session ? session.name : null)
  }

  return (
    <SidebarProvider
      className="relative h-svh overflow-hidden"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <AppSidebar
        containers={containers}
        loading={loading}
        error={error}
        activeSessionName={activeSessionName}
        onSelectSession={handleSelectSession}
        onRefresh={refresh}
        confirmLeaveIfDirty={confirmLeaveIfDirty}
        creatingAgentContainer={creatingAgentContainer}
        onCreatingAgentContainerChange={setCreatingAgentContainer}
      />
      {isMobile ? null : (
        <ResizeHandle
          onPointerDown={onHandlePointerDown}
          dragging={sidebarDragging}
          className="absolute inset-y-0 z-20 -ml-1"
          style={{ left: sidebarWidth }}
        />
      )}
      <SidebarInset className="min-h-0 min-w-0">
        <WorkspacePanel
          activeSession={activeSession}
          onAfterSend={refresh}
          filesEditorRef={filesEditorRef}
          confirmLeaveIfDirty={confirmLeaveIfDirty}
          creatingAgent={creatingAgentContainer !== null}
        />
      </SidebarInset>
      {unsavedChangesDialog}
    </SidebarProvider>
  )
}

export default App
