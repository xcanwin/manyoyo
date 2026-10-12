import { describe, expect, test } from "vitest"

import { firstProblem, formatDuration, resultLabel } from "./last-run"

const stage = (id: string, result: string) => ({ id, result, logFile: `01-${id}.log`, durationMs: 1000, detail: "" })

describe("last-run", () => {
  test("耗时：秒、分秒、未知", () => {
    expect(formatDuration(900)).toBe("1 秒")
    expect(formatDuration(65_000)).toBe("1 分 05 秒")
    expect(formatDuration(null)).toBe("-")
  })

  test("排障先看第一个失败的阶段；没有失败就看中断的；都没有返回 null", () => {
    expect(firstProblem([stage("a", "done"), stage("b", "aborted"), stage("c", "failed")])?.id).toBe("c")
    expect(firstProblem([stage("a", "done"), stage("b", "aborted")])?.id).toBe("b")
    expect(firstProblem([stage("a", "done")])).toBeNull()
  })

  test("结果有中文名，未知结果原样显示", () => {
    expect(resultLabel("failed")).toBe("失败")
    expect(resultLabel("weird")).toBe("weird")
  })
})
