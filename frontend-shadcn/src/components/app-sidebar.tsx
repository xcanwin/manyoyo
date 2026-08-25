import * as React from "react"
import { MoreHorizontalIcon, PlusIcon, SettingsIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiPost,
  type ContainerGroup,
  type SessionSummary,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CloneNameDialog, type CloneMode } from "@/components/clone-name-dialog"
import { CreateContainerDialog } from "@/components/create-container-dialog"
import { PromptDialog } from "@/components/prompt-dialog"
import { SystemSettingsDialog } from "@/components/system-settings-dialog"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

type NavLevel = "containers" | "agents"

function formatUpdatedAt(value: string): string {
  if (!value) return "暂无更新"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

// 与旧版前端的 suggestCloneContainerName 对齐：从 "-copy1" 起，
// 避开已存在的容器名，找到最小可用的序号
function suggestCloneContainerName(containers: ContainerGroup[], baseName: string): string {
  const taken = new Set(containers.map((group) => group.containerName))
  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^${escapedBase}-copy(\\d+)$`)
  let maxN = 0
  taken.forEach((name) => {
    const matched = name.match(pattern)
    if (matched) {
      const n = Number(matched[1])
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
  })
  return `${baseName}-copy${maxN + 1}`
}

export function AppSidebar({
  containers,
  loading,
  error,
  activeSessionName,
  onSelectSession,
  onRefresh,
  confirmLeaveIfDirty,
  creatingAgentContainer,
  onCreatingAgentContainerChange,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  containers: ContainerGroup[]
  loading: boolean
  error: string
  activeSessionName: string | null
  onSelectSession: (session: SessionSummary | null) => void
  onRefresh: () => Promise<SessionSummary[]>
  confirmLeaveIfDirty: () => Promise<boolean>
  creatingAgentContainer: string | null
  onCreatingAgentContainerChange: (containerName: string | null) => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [navLevel, setNavLevel] = React.useState<NavLevel>("containers")
  const [navContainer, setNavContainer] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [actionError, setActionError] = React.useState("")
  const [remarkDialog, setRemarkDialog] = React.useState<{
    kind: "container" | "agent"
    key: string
    initial: string
  } | null>(null)
  const [cloneDialog, setCloneDialog] = React.useState<{
    mode: CloneMode
    containerName: string
  } | null>(null)
  const [removeDialog, setRemoveDialog] = React.useState<{
    title: string
    message: string
    resolve: (choice: "keep-history" | "with-history" | null) => void
  } | null>(null)

  // 与旧版前端的 confirmRemoveChoice 对齐：取消 / 仅移除保留历史 / 移除并删除历史 三选一
  function confirmRemoveChoice(
    title: string,
    message: string
  ): Promise<"keep-history" | "with-history" | null> {
    return new Promise((resolve) => {
      setRemoveDialog({ title, message, resolve })
    })
  }

  function settleRemoveDialog(choice: "keep-history" | "with-history" | null) {
    setRemoveDialog((current) => {
      current?.resolve(choice)
      return null
    })
  }

  // 与旧版前端（app.js groupSessionsByContainer/renderAgentLevel）保持一致：
  // synthetic 是"从未真正对话过"的默认 AGENT 占位符，不计入 AGENT 数也不在列表里展示
  const agentCount = containers.reduce(
    (total, group) => total + group.sessions.filter((s) => s.synthetic !== true).length,
    0
  )
  const activeGroup = containers.find((group) => group.containerName === navContainer)
  const visibleAgentSessions = React.useMemo(
    () => (activeGroup?.sessions ?? []).filter((s) => s.synthetic !== true),
    [activeGroup]
  )
  // 从agent列表返回容器列表后，靠当前激活的会话反推它所在的容器，
  // 让容器列表也能高亮出"正在对话的是哪个容器"
  const activeContainerName = React.useMemo(() => {
    if (!activeSessionName) return ""
    return (
      containers.find((group) => group.sessions.some((s) => s.name === activeSessionName))
        ?.containerName ?? ""
    )
  }, [containers, activeSessionName])

  const filteredContainers = React.useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return containers
    return containers.filter(
      (group) =>
        group.containerName.toLowerCase().includes(text) ||
        group.hostPath.toLowerCase().includes(text)
    )
  }, [containers, query])

  function goToContainers() {
    setNavLevel("containers")
    setNavContainer("")
  }

  function goToAgents(containerName: string) {
    setNavLevel("agents")
    setNavContainer(containerName)
  }

  // 移动端选中 AGENT 后自动收起侧边栏 Sheet，露出右侧聊天内容
  async function selectSession(session: SessionSummary | null) {
    if (session && session.name !== activeSessionName) {
      if (!(await confirmLeaveIfDirty())) return
    }
    onSelectSession(session)
    if (session && isMobile) setOpenMobile(false)
  }

  async function handleCreated(name: string) {
    setActionError("")
    try {
      const freshSessions = await onRefresh()
      goToAgents(name)
      const created =
        freshSessions.find((s) => s.name === name) ||
        freshSessions.find((s) => s.containerName === name)
      if (created) selectSession(created)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "刷新会话列表失败")
    }
  }

  async function createAgent(containerName: string) {
    if (creatingAgentContainer) return
    if (!(await confirmLeaveIfDirty())) return
    setActionError("")
    onCreatingAgentContainerChange(containerName)
    try {
      // 接口直接返回新建 AGENT 的 name，比"倒序猜最后一个"更可靠——
      // 会话列表的顺序并不保证与创建时间一致
      const data = await apiPost(`/api/sessions/${encodeURIComponent(containerName)}/agents`, {})
      const newName = typeof data.name === "string" ? data.name : ""
      const freshSessions = await onRefresh()
      goToAgents(containerName)
      const created = freshSessions.find((s) => s.name === newName)
      if (created) selectSession(created)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "新建 AGENT 失败")
    } finally {
      onCreatingAgentContainerChange(null)
    }
  }

  function editContainerRemark(containerName: string, current: string) {
    setRemarkDialog({ kind: "container", key: containerName, initial: current })
  }

  function openCloneDialog(mode: CloneMode, containerName: string) {
    setCloneDialog({ mode, containerName })
  }

  async function submitClone(name: string) {
    if (!cloneDialog) return
    const endpoint = cloneDialog.mode === "duplicate" ? "duplicate" : "clone-config"
    const data = await apiPost(
      `/api/sessions/${encodeURIComponent(cloneDialog.containerName)}/${endpoint}`,
      name ? { containerName: name } : {}
    )
    const freshSessions = await onRefresh()
    const newContainerName = String(data.name)
    goToAgents(newContainerName)
    const created =
      freshSessions.find((s) => s.name === newContainerName) ||
      freshSessions.find((s) => s.containerName === newContainerName)
    if (created) selectSession(created)
  }

  async function removeContainer(containerName: string) {
    const choice = await confirmRemoveChoice(
      "删除容器",
      `确认删除容器 ${containerName}？可以选择是否同时删除该容器的全部历史记录（消息与事件日志）。`
    )
    if (!choice) return
    const removeHistory = choice === "with-history"
    setActionError("")
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(containerName)}/remove`, {
        removeHistory,
      })
      if (navContainer === containerName) goToContainers()
      if (activeSessionName && activeSessionName.startsWith(containerName)) {
        onSelectSession(null)
      }
      await onRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除容器失败")
    }
  }

  function editAgentRemark(session: SessionSummary) {
    setRemarkDialog({ kind: "agent", key: session.name, initial: session.agentRemark })
  }

  async function submitRemark(value: string) {
    if (!remarkDialog) return
    const endpoint =
      remarkDialog.kind === "container" ? "container-remark" : "agent-remark"
    await apiPost(`/api/sessions/${encodeURIComponent(remarkDialog.key)}/${endpoint}`, {
      remark: value,
    })
    await onRefresh()
  }

  async function removeAgent(session: SessionSummary) {
    const agentLabel = session.agentRemark || session.agentName
    const choice = await confirmRemoveChoice(
      "删除 AGENT",
      `确认删除 AGENT ${agentLabel}？可以选择是否同时删除它的历史记录（消息与事件日志）。`
    )
    if (!choice) return
    const removeHistory = choice === "with-history"
    setActionError("")
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(session.name)}/remove-with-history`, {
        removeHistory,
      })
      if (activeSessionName === session.name) onSelectSession(null)
      await onRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除 AGENT 失败")
    }
  }

  return (
    <Sidebar {...props}>
      <SidebarHeader className="gap-3 px-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold tracking-tight">
            MANYOYO Web
          </span>
        </div>
        <Button
          className="w-full"
          size="lg"
          disabled={navLevel === "agents" && creatingAgentContainer === navContainer}
          onClick={() =>
            navLevel === "agents" ? createAgent(navContainer) : setCreateOpen(true)
          }
        >
          {navLevel === "agents" && creatingAgentContainer === navContainer ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlusIcon data-icon="inline-start" />
          )}
          {navLevel === "agents"
            ? creatingAgentContainer === navContainer
              ? "创建中..."
              : "新建AGENT"
            : "新建容器"}
        </Button>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>工作台</span>
          <span>
            {loading
              ? "加载中..."
              : navLevel === "agents"
                ? `${visibleAgentSessions.length} 个 AGENT`
                : `${containers.length} 个容器 / ${agentCount} 个 AGENT`}
          </span>
        </div>
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap gap-1 text-xs">
            <BreadcrumbItem>
              {navLevel === "containers" ? (
                <BreadcrumbPage>全部容器</BreadcrumbPage>
              ) : (
                <button
                  type="button"
                  onClick={goToContainers}
                  className="text-muted-foreground hover:text-foreground"
                >
                  全部容器
                </button>
              )}
            </BreadcrumbItem>
            {navLevel === "agents" && activeGroup ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-32 truncate">
                    {activeGroup.containerRemark || activeGroup.containerName}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        {navLevel === "containers" ? (
          <SidebarInput
            placeholder="按工作目录 / 容器名搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        {error || actionError ? (
          <p className="text-xs text-destructive">{error || actionError}</p>
        ) : null}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navLevel === "containers"
                ? filteredContainers.map((group) => (
                    <SidebarMenuItem key={group.containerName}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={group.containerName === activeContainerName}
                        onClick={() => goToAgents(group.containerName)}
                        className="h-auto flex-col items-start gap-1 py-2.5"
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="truncate font-medium">
                            {group.containerRemark || group.containerName}
                          </span>
                          <Badge
                            variant={
                              group.status.toLowerCase().includes("up")
                                ? "default"
                                : "outline"
                            }
                            className={cn(
                              "ml-auto shrink-0",
                              group.status.toLowerCase().includes("up") &&
                                "bg-emerald-600 text-white"
                            )}
                          >
                            {group.status === "history"
                              ? "仅历史"
                              : group.status.toLowerCase().includes("up")
                                ? "运行中"
                                : "已停止"}
                          </Badge>
                        </span>
                        <span className="w-full truncate text-xs text-muted-foreground">
                          {group.hostPath}
                        </span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <SidebarMenuAction showOnHover>
                              <MoreHorizontalIcon />
                            </SidebarMenuAction>
                          }
                        />
                        <DropdownMenuContent side="right" align="start" className="w-56">
                          <DropdownMenuGroup className="flex flex-col gap-1">
                            <DropdownMenuItem
                              onClick={() =>
                                editContainerRemark(
                                  group.containerName,
                                  group.containerRemark
                                )
                              }
                            >
                              编辑备注
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={creatingAgentContainer === group.containerName}
                              onClick={() => createAgent(group.containerName)}
                            >
                              {creatingAgentContainer === group.containerName ? (
                                <>
                                  <Spinner data-icon="inline-start" />
                                  创建中...
                                </>
                              ) : (
                                "新建 AGENT"
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                openCloneDialog("clone-config", group.containerName)
                              }
                            >
                              创建相同配置容器
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                openCloneDialog("duplicate", group.containerName)
                              }
                            >
                              复制容器
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                removeContainer(group.containerName)
                              }
                            >
                              删除容器
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SidebarMenuItem>
                  ))
                : visibleAgentSessions.map((session) => (
                    <SidebarMenuItem key={session.name}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={activeSessionName === session.name}
                        onClick={() => selectSession(session)}
                        className="h-auto flex-col items-start gap-1 py-2.5"
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="truncate font-medium">
                            {session.agentRemark || session.agentName}
                          </span>
                          {session.archived ? (
                            <Badge variant="outline" className="ml-auto shrink-0">
                              已停止
                            </Badge>
                          ) : null}
                        </span>
                        <span className="w-full truncate text-xs text-muted-foreground">
                          {formatUpdatedAt(session.updatedAt || "")}
                        </span>
                      </SidebarMenuButton>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <SidebarMenuAction showOnHover>
                              <MoreHorizontalIcon />
                            </SidebarMenuAction>
                          }
                        />
                        <DropdownMenuContent side="right" align="start" className="w-56">
                          <DropdownMenuGroup className="flex flex-col gap-1">
                            <DropdownMenuItem
                              onClick={() => editAgentRemark(session)}
                            >
                              编辑备注
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => removeAgent(session)}
                            >
                              删除 AGENT
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </SidebarMenuItem>
                  ))}
              {navLevel === "containers" && !loading && filteredContainers.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {query.trim() ? "没有匹配的容器" : "暂无 manyoyo 容器"}
                </div>
              ) : null}
              {navLevel === "agents" && visibleAgentSessions.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  该容器下暂无 AGENT
                </div>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 pb-3">
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon data-icon="inline-start" />
          系统设置
        </Button>
      </SidebarFooter>

      <SystemSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <CreateContainerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      <PromptDialog
        open={remarkDialog !== null}
        onOpenChange={(next) => {
          if (!next) setRemarkDialog(null)
        }}
        title={remarkDialog?.kind === "container" ? "设置容器备注" : "设置 AGENT 备注"}
        description="留空可清除备注。"
        label="备注"
        initialValue={remarkDialog?.initial ?? ""}
        onSubmit={submitRemark}
      />

      <CloneNameDialog
        open={cloneDialog !== null}
        onOpenChange={(next) => {
          if (!next) setCloneDialog(null)
        }}
        mode={cloneDialog?.mode ?? "clone-config"}
        sourceContainerName={cloneDialog?.containerName ?? ""}
        suggestedName={
          cloneDialog
            ? suggestCloneContainerName(containers, cloneDialog.containerName)
            : ""
        }
        onSubmit={submitClone}
      />

      <Dialog
        open={removeDialog !== null}
        onOpenChange={(next: boolean) => {
          if (!next) settleRemoveDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>{removeDialog?.title}</DialogTitle>
          <DialogDescription>{removeDialog?.message}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => settleRemoveDialog(null)}>
              取消
            </Button>
            <Button variant="outline" onClick={() => settleRemoveDialog("keep-history")}>
              否，保留历史
            </Button>
            <Button variant="destructive" onClick={() => settleRemoveDialog("with-history")}>
              是，连同历史一起删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}
