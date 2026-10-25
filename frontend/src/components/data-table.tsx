import * as React from "react"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { Hint } from "@/components/hint"
export type DataColumn<T> = {
  key: string
  header: string
  render: (row: T) => React.ReactNode
  // 手机卡片的标题列（没标就用第一列）
  primary?: boolean
  // 手机上不显示
  mobile?: "hidden"
  // 路径、地址、配置名：等宽 + 截断
  mono?: boolean
  // 只用来写列宽之类的布局；文字一律左对齐
  className?: string
}

// 只读数据列表（STYLE.md 第 10 节）：桌面是吸顶表头的表格，手机（<768px）自动变成卡片，不横向滚动。
// 文字和数字一律左对齐；操作列靠右，放在 actions 里。
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  actions,
  onRowClick,
  rowTestId,
  loading = false,
  empty,
  label,
}: {
  columns: DataColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  actions?: (row: T) => React.ReactNode
  onRowClick?: (row: T) => void
  // 给每一行（卡片）加 data-testid，测试和体验脚本用
  rowTestId?: (row: T) => string
  loading?: boolean
  empty?: { title: string; description?: string; action?: React.ReactNode }
  // 表格的无障碍名称
  label: string
}) {
  const isMobile = useIsMobile()

  if (loading) {
    return (
      <div
        data-slot="data-table-loading"
        className="flex flex-col gap-2"
        role="status"
        aria-label="加载中"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <Empty data-slot="data-table-empty" className="border">
        <EmptyHeader>
          <EmptyTitle>{empty?.title ?? "没有数据"}</EmptyTitle>
          {empty?.description ? (
            <EmptyDescription>{empty.description}</EmptyDescription>
          ) : null}
        </EmptyHeader>
        {empty?.action ? <EmptyContent>{empty.action}</EmptyContent> : null}
      </Empty>
    )
  }

  if (isMobile) {
    const primary = columns.find((c) => c.primary) ?? columns[0]
    const rest = columns.filter((c) => c !== primary && c.mobile !== "hidden")
    return (
      <div
        data-slot="data-table-cards"
        className="flex flex-col gap-2"
        role="list"
        aria-label={label}
      >
        {rows.map((row) => (
          <Card
            key={rowKey(row)}
            size="sm"
            role="listitem"
            data-testid={rowTestId?.(row)}
            className={cn(onRowClick && "cursor-pointer")}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            <CardHeader>
              <CardTitle className="min-w-0 break-words">
                {primary.render(row)}
              </CardTitle>
            </CardHeader>
            {rest.length > 0 ? (
              <CardContent className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
                {rest.map((col) => (
                  <React.Fragment key={col.key}>
                    <Hint>
                      {col.header}
                    </Hint>
                    <span
                      className={cn(
                        "min-w-0 text-sm break-words",
                        col.mono && "font-mono"
                      )}
                    >
                      {col.render(row)}
                    </span>
                  </React.Fragment>
                ))}
              </CardContent>
            ) : null}
            {actions ? (
              <CardFooter
                className="flex-wrap justify-end gap-3 [&_[data-slot=button]]:touch-hit"
                onClick={(e) => e.stopPropagation()}
              >
                {actions(row)}
              </CardFooter>
            ) : null}
          </Card>
        ))}
      </div>
    )
  }

  return (
    <Table aria-label={label} data-slot="data-table">
      <TableHeader>
        <TableRow className="hover:bg-muted">
          {columns.map((col) => (
            <TableHead key={col.key} className={col.className}>
              {col.header}
            </TableHead>
          ))}
          {actions ? <TableHead className="w-px" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            data-testid={rowTestId?.(row)}
            className={cn(
              onRowClick &&
                "cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
            )}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onRowClick(row)
                    }
                  }
                : undefined
            }
          >
            {columns.map((col) => (
              <TableCell
                key={col.key}
                className={cn(
                  col.mono && "max-w-56 truncate font-mono",
                  col.className
                )}
              >
                {col.render(row)}
              </TableCell>
            ))}
            {actions ? (
              <TableCell className="w-px" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-end gap-2">
                  {actions(row)}
                </div>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
