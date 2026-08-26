import * as React from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { ResizeHandle } from "@/components/resize-handle"
import { WorkspacePanel } from "@/components/workspace-panel"
import { useResizableWidth } from "@/hooks/use-resizable-width"
import { useSessions } from "@/hooks/use-sessions"
import { useUnsavedChangesDialog } from "@/hooks/use-unsaved-changes-dialog"
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import type { FilesEditorState } from "@/components/files-panel"
import type { SessionSummary } from "@/lib/api"

// 侧边栏收起（offcanvas）后 Sidebar 本身平移出屏幕，但这根拖拽线之前是按 sidebarWidth
// 独立定位的，跟收起状态无关——收起后线还留在原地、也还能拖，这里收起时直接不渲染
function SidebarResizeHandle({
  width,
  dragging,
  onPointerDown,
}: {
  width: number
  dragging: boolean
  onPointerDown: (event: React.PointerEvent) => void
}) {
  const { isMobile, state } = useSidebar()
  if (isMobile || state === "collapsed") return null
  return (
    <ResizeHandle
      onPointerDown={onPointerDown}
      dragging={dragging}
      className="absolute inset-y-0 z-20 -ml-1"
      style={{ left: width }}
    />
  )
}

export function App() {
  const { sessions, containers, loading, error, refresh } = useSessions()
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

  // 与旧版前端 buildDocumentTitle 对齐：按当前 AGENT 动态改写页面标题，方便
  // 并行打开多个会话时在浏览器标签/任务切换器里辨认。--title 传了自定义静态
  // 标题时，服务端会在 <head> 里插一个 meta 标记，这里跳过动态改写不覆盖它
  React.useEffect(() => {
    if (document.querySelector('meta[name="manyoyo-serve-title"]')) return
    const agentName = (activeSession?.agentRemark || activeSession?.agentName || "").trim()
    document.title = agentName ? `${agentName} · MANYOYO Web` : "MANYOYO Web"
  }, [activeSession])

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
      <SidebarResizeHandle
        width={sidebarWidth}
        dragging={sidebarDragging}
        onPointerDown={onHandlePointerDown}
      />
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
