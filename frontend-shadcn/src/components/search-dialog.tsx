import { BoxIcon, BotIcon } from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandInput,
  CommandList,
} from "@/components/ui/command"
import { scoreSearchCandidate, type ContainerGroup, type SessionSummary } from "@/lib/api"

export function SearchDialog({
  open,
  onOpenChange,
  containers,
  onSelectContainer,
  onSelectAgent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  containers: ContainerGroup[]
  onSelectContainer: (containerName: string) => void
  onSelectAgent: (containerName: string, session: SessionSummary) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">搜索容器 / AGENT</DialogTitle>
        <Command className="rounded-lg" filter={scoreSearchCandidate}>
          {/* 默认右上角关闭按钮是 absolute top-2 right-2，跟输入框同一行会挡住末尾文字，
              给输入框本身留出右侧空间 */}
          <CommandInput className="pr-8" placeholder="按容器名、工作目录、AGENT 名称 / 备注搜索..." autoFocus />
          <CommandList>
            <CommandEmpty>没有匹配结果</CommandEmpty>
            <CommandGroup heading="容器">
              {containers.map((group) => (
                <CommandItem
                  key={group.containerName}
                  value={`container:${group.containerName} ${group.containerRemark} ${group.hostPath}`}
                  onSelect={() => {
                    onSelectContainer(group.containerName)
                    onOpenChange(false)
                  }}
                >
                  <BoxIcon />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{group.containerRemark || group.containerName}</span>
                    <span className="truncate text-xs text-muted-foreground">{group.hostPath}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="AGENT">
              {containers.flatMap((group) =>
                group.sessions
                  .filter((session) => session.synthetic !== true)
                  .map((session) => (
                    <CommandItem
                      key={session.name}
                      value={`agent:${session.agentName} ${session.agentRemark} ${group.containerName} ${group.containerRemark}`}
                      onSelect={() => {
                        onSelectAgent(group.containerName, session)
                        onOpenChange(false)
                      }}
                    >
                      <BotIcon />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{session.agentRemark || session.agentName}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {group.containerRemark || group.containerName}
                        </span>
                      </div>
                    </CommandItem>
                  ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
