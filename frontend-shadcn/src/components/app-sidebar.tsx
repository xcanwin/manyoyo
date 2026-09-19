import * as React from "react"
import {
  ArrowLeftIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import {
  apiGet,
  apiPost,
  isSessionOfContainer,
  pickSessionAfterRemoval,
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
import { LogsDialog } from "@/components/logs-dialog"
import { PromptDialog } from "@/components/prompt-dialog"
import { QuickChatSetupDialog } from "@/components/quick-chat-setup-dialog"
import { SearchDialog } from "@/components/search-dialog"
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
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

type NavLevel = "containers" | "agents"

// 点击侧边栏"容器"行只切 navLevel/navContainer 这两个纯 UI 导航状态
// （见 goToAgents），本身不会触发 selectSession，主聊天区不会跟着切换。
// 这里算出 goToAgents 之后该自动选中哪个 session，交给调用方补上
// selectSession(...) 这一步：已经在这个容器里就保持原选中，否则选第一个
// 非 synthetic 的真实 AGENT，容器下只有 synthetic 占位就退回选它。
export function pickDefaultSessionForContainer(
  sessions: SessionSummary[],
  activeSessionName: string | null
): SessionSummary | null {
  const activeMatch = sessions.find((s) => s.name === activeSessionName)
  if (activeMatch) return activeMatch
  const real = sessions.find((s) => s.synthetic !== true)
  if (real) return real
  return sessions[0] ?? null
}

// 记住上次停留的容器/AGENT 两级导航位置，刷新页面或重开页面后能直接回到原来的上下文
const SIDEBAR_NAV_STORAGE_KEY = "manyoyo.web.sidebarNav.v1"

function loadPersistedNavState(): { navLevel: NavLevel; navContainer: string } {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_NAV_STORAGE_KEY)
    if (!raw) return { navLevel: "containers", navContainer: "" }
    const parsed = JSON.parse(raw) as { navLevel?: unknown; navContainer?: unknown }
    return {
      navLevel: parsed.navLevel === "agents" ? "agents" : "containers",
      navContainer: typeof parsed.navContainer === "string" ? parsed.navContainer : "",
    }
  } catch {
    return { navLevel: "containers", navContainer: "" }
  }
}

function formatUpdatedAt(value: string): string {
  return formatDateTime(value) || "暂无更新"
}

// 克隆容器的默认名：从 "-copy1" 起，避开已存在的容器名，找到最小可用的序号
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
  const [navLevel, setNavLevel] = React.useState<NavLevel>(() => loadPersistedNavState().navLevel)
  const [navContainer, setNavContainer] = React.useState(() => loadPersistedNavState().navContainer)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [quickChatSetupOpen, setQuickChatSetupOpen] = React.useState(false)
  const [quickChatBusy, setQuickChatBusy] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
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

  // 删除确认是三选一：取消 / 仅移除保留历史 / 移除并删除历史
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

  // AGENT 多到需要滚动时，刷新页面或从别处切回来，选中项可能落在可视区外面，
  // 看起来像"什么都没选中"。block: "nearest" 只在真的看不见时才滚，已经可见
  // 就不动，避免每次列表刷新都把侧边栏往回拽
  const activeSessionRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    activeSessionRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeSessionName, navContainer])

  React.useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_NAV_STORAGE_KEY,
        JSON.stringify({ navLevel, navContainer })
      )
    } catch {
      // localStorage 不可用（隐私模式等）时静默失败，不影响导航本身
    }
  }, [navLevel, navContainer])

  // 会话列表每次刷新后，如果持久化下来的 navContainer 已经不存在了（容器被删除/改名），退回容器列表层级，避免停留在
  // 一个空的、找不到对应容器的 AGENT 列表页。渲染期间对比容器名单签名来判断
  // "是否发生了一次新的刷新"，而不是在 effect 里同步 setState；首次加载数据
  // 完成前（loading）签名固定为 null，不参与校验，避免 containers 还是空数组时
  // 误把刚恢复的导航状态清空
  const containersSignature = loading
    ? null
    : containers.map((group) => group.containerName).join(",")
  const [prevContainersSignature, setPrevContainersSignature] = React.useState(containersSignature)
  if (containersSignature !== prevContainersSignature) {
    setPrevContainersSignature(containersSignature)
    if (
      containersSignature !== null &&
      navLevel === "agents" &&
      !containers.some((group) => group.containerName === navContainer)
    ) {
      setNavLevel("containers")
      setNavContainer("")
    }
  }
  // 从agent列表返回容器列表后，靠当前激活的会话反推它所在的容器，
  // 让容器列表也能高亮出"正在对话的是哪个容器"
  const activeContainerName = React.useMemo(() => {
    if (!activeSessionName) return ""
    return (
      containers.find((group) => group.sessions.some((s) => s.name === activeSessionName))
        ?.containerName ?? ""
    )
  }, [containers, activeSessionName])

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
    applySelectedSession(session)
  }

  // 新建/克隆流程在入口已经问过一次"有未保存的修改要不要保存"了，收尾时直接选中
  // 新会话，不要再走 selectSession——选"不保存"并不会清掉编辑器的 isDirty，
  // 会被同一个弹窗连问两遍；第二遍点取消还会导致 agent 已创建但界面不跳过去
  function applySelectedSession(session: SessionSummary | null) {
    onSelectSession(session)
    if (session && isMobile) setOpenMobile(false)
  }

  // 新建成功但会话列表没刷新出来时必须明说：refresh 失败只会返回空数组、不抛错，
  // 否则表现为"点了新建什么都没发生"（服务端其实已经建好了）
  function selectCreatedSession(freshSessions: SessionSummary[], matcher: (s: SessionSummary) => boolean) {
    const created = freshSessions.find(matcher)
    if (created) {
      applySelectedSession(created)
      return
    }
    setActionError("已创建成功，但会话列表刷新失败，请稍后重试或刷新页面")
  }

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  async function handleCreated(name: string) {
    setActionError("")
    try {
      const freshSessions = await onRefresh()
      goToAgents(name)
      selectCreatedSession(freshSessions, (s) => s.name === name || s.containerName === name)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "刷新会话列表失败")
    }
  }

  // 年月日-时分秒，比 manyoyo.json 里 containerName 模板的 {now}（MMDD-HHmm）多带年份和秒数——
  // 短时间内连点快捷对话时目录名/容器名不会撞车
  function formatQuickChatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }

  async function runQuickChatWithConfig(quickChatPath: string, quickChatRun: string) {
    setQuickChatBusy(true)
    setActionError("")
    try {
      const timestamp = formatQuickChatTimestamp(new Date())
      const requestedDir = `${quickChatPath.replace(/\/+$/, "")}/${timestamp}`
      // mkdir 接口内部会展开 ~ 并返回解析后的绝对路径——新建容器要拿这个绝对路径，
      // 不能直接把带 ~ 的原始字符串传给 hostPath（Node fs 不认识 ~，会报路径不存在）
      const mkdirResult = await apiPost("/api/fs/directories/mkdir", { path: requestedDir })
      const newDir = typeof mkdirResult.path === "string" && mkdirResult.path ? mkdirResult.path : requestedDir
      const data = await apiPost("/api/sessions", {
        run: quickChatRun,
        createOptions: {
          hostPath: newDir,
          containerPath: newDir,
          containerName: `my-easy-${timestamp}`,
        },
      })
      await handleCreated(String(data.name))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "快捷对话创建失败")
    } finally {
      setQuickChatBusy(false)
    }
  }

  async function startQuickChat() {
    if (quickChatBusy) return
    if (!(await confirmLeaveIfDirty())) return
    setActionError("")
    try {
      const data = await apiGet("/api/system/quick-chat-config")
      const quickChatPath = typeof data.path === "string" ? data.path : ""
      const quickChatRun = typeof data.run === "string" ? data.run : ""
      if (quickChatPath && quickChatRun) {
        await runQuickChatWithConfig(quickChatPath, quickChatRun)
      } else {
        setQuickChatSetupOpen(true)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "读取快捷对话配置失败")
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
      selectCreatedSession(freshSessions, (s) => s.name === newName)
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
    selectCreatedSession(
      freshSessions,
      (s) => s.name === newContainerName || s.containerName === newContainerName
    )
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
      const wasActive = isSessionOfContainer(activeSessionName, containerName)
      const freshSessions = await onRefresh()
      if (wasActive) {
        // 整个容器没了，同容器里挑不出接班的，直接取剩下最新创建的会话
        onSelectSession(
          pickSessionAfterRemoval(freshSessions, { name: "", containerName })
        )
      }
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
      `确认删除 ${agentLabel}？可以选择是否同时删除它的历史记录（消息与事件日志）。`
    )
    if (!choice) return
    const removeHistory = choice === "with-history"
    setActionError("")
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(session.name)}/remove-with-history`, {
        removeHistory,
      })
      const wasActive = activeSessionName === session.name
      const freshSessions = await onRefresh()
      if (wasActive) {
        onSelectSession(pickSessionAfterRemoval(freshSessions, session))
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除 AGENT 失败")
    }
  }

  // 移动端侧边栏本身是个 Sheet（已经是一层浮层），从它里面再打开 Dialog 时
  // base-ui 会复用这层已有的遮罩、不再单独虚化——手动给 Sheet 内容虚化+禁用交互，
  // 跟 create-container-dialog.tsx 里嵌套打开目录选择器时的处理方式保持一致
  const anyDialogOpen = Boolean(
    searchOpen || quickChatSetupOpen || settingsOpen || logsOpen || createOpen || remarkDialog || cloneDialog || removeDialog
  )

  return (
    <Sidebar
      {...props}
      className={cn(isMobile && anyDialogOpen && "pointer-events-none opacity-40 blur-[2px]")}
    >
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
        <Button className="w-full" variant="outline" disabled={quickChatBusy} onClick={startQuickChat}>
          {quickChatBusy ? <Spinner data-icon="inline-start" /> : <MessageCircleIcon data-icon="inline-start" />}
          {quickChatBusy ? "创建中..." : "快捷对话"}
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
            <BreadcrumbItem className="shrink-0">
              <Button
                variant="outline"
                size="xs"
                disabled={navLevel === "containers"}
                onClick={navLevel === "containers" ? undefined : goToContainers}
                // Breadcrumb 自己套了一层 text-muted-foreground，Button 默认不强制文字颜色，
                // 会被继承成灰色——这里显式改回前景色，不然容器名旁边这颗按钮看着像不能点
                className="text-foreground"
              >
                {navLevel === "containers" ? (
                  // 容器列表层级已经在最顶层，没有"返回"语义了，箭头图标换成一个等宽的圆点占位，
                  // 既不会因为图标消失导致按钮宽度跳动，也不会让人误以为还能往回点
                  <span data-icon="inline-start" className="flex size-4 items-center justify-center">
                    <span className="size-1.5 rounded-full bg-current" />
                  </span>
                ) : (
                  <ArrowLeftIcon data-icon="inline-start" />
                )}
                全部容器
              </Button>
            </BreadcrumbItem>
            {navLevel === "agents" && activeGroup ? (
              <>
                <BreadcrumbSeparator className="shrink-0" />
                <BreadcrumbItem className="min-w-0 flex-1">
                  <BreadcrumbPage className="block truncate">
                    {activeGroup.containerRemark || activeGroup.containerName}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        <Button
          variant="outline"
          className="w-full justify-start bg-background text-muted-foreground shadow-none"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon data-icon="inline-start" />
          搜索容器 / AGENT
          <kbd className="ml-auto font-mono text-xs text-muted-foreground">⌘K</kbd>
        </Button>
        {error || actionError ? (
          <p className="text-xs text-destructive">{error || actionError}</p>
        ) : null}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pt-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navLevel === "containers"
                ? containers.map((group) => (
                    <SidebarMenuItem key={group.containerName}>
                      <SidebarMenuButton
                        size="lg"
                        isActive={group.containerName === activeContainerName}
                        onClick={() => {
                          goToAgents(group.containerName)
                          selectSession(
                            pickDefaultSessionForContainer(group.sessions, activeSessionName)
                          )
                        }}
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
                            <SidebarMenuAction showOnHover title="更多操作" aria-label="更多操作">
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
                        ref={activeSessionName === session.name ? activeSessionRef : undefined}
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
                            <SidebarMenuAction showOnHover title="更多操作" aria-label="更多操作">
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
              {navLevel === "containers" && !loading && containers.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无 manyoyo 容器</div>
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

      <SidebarFooter className="flex-row gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon data-icon="inline-start" />
          系统设置
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          onClick={() => setLogsOpen(true)}
        >
          <ScrollTextIcon data-icon="inline-start" />
          运行日志
        </Button>
      </SidebarFooter>

      <SystemSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <LogsDialog open={logsOpen} onOpenChange={setLogsOpen} />

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        containers={containers}
        onSelectContainer={(containerName) => {
          goToAgents(containerName)
          const group = containers.find((g) => g.containerName === containerName)
          selectSession(pickDefaultSessionForContainer(group?.sessions ?? [], activeSessionName))
        }}
        onSelectAgent={(containerName, session) => {
          goToAgents(containerName)
          selectSession(session)
        }}
      />

      <QuickChatSetupDialog
        open={quickChatSetupOpen}
        onOpenChange={setQuickChatSetupOpen}
        initialPath=""
        initialRun=""
        onSaved={(path, run) => runQuickChatWithConfig(path, run)}
      />

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
