import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { LastRunPanel } from "./last-run-panel"
import { RemotePanel } from "./remote-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const respond = (body: unknown) => ({ ok: true, json: async () => body }) as Response

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("RemotePanel（一键发布 / --remote 的远端进度）", () => {
  test("显示流水线各阶段的结果与耗时；失败时给出失败阶段的日志位置", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond({
          run: {
            runId: 9,
            status: "completed",
            conclusion: "failure",
            url: "https://github.com/x/y/actions/runs/9",
            stages: [
              { id: "prepare", result: "success", durationSec: 6 },
              { id: "packages", result: "failure", durationSec: 240 },
            ],
          },
          report: { logDir: "/tmp/r/remote-9", failedLogs: ["/tmp/r/remote-9/failed-packages.log"] },
        }),
      ),
    )
    await act(async () => {
      root.render(<RemotePanel refreshKey={0} />)
    })
    await flush()
    expect(container.textContent).toContain("#9")
    expect(container.textContent).toContain("prepare")
    expect(container.textContent).toContain("packages")
    expect(container.textContent).toContain("4 分 00 秒")
    expect(container.textContent).toContain("失败阶段的日志在：/tmp/r/remote-9/failed-packages.log")
  })

  test("没有运行时什么也不显示；进行中提示关掉页面也不影响", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond({ run: null })))
    await act(async () => {
      root.render(<RemotePanel refreshKey={0} />)
    })
    await flush()
    expect(container.textContent).toBe("")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond({ run: { runId: 3, status: "in_progress", conclusion: "", url: "u", stages: [{ id: "test", result: "running", durationSec: 5 }] } })),
    )
    await act(async () => {
      root.render(<RemotePanel refreshKey={1} />)
    })
    await flush()
    expect(container.textContent).toContain("关掉页面也不影响")
  })
})

describe("LastRunPanel（本地任务日志，按阶段展开）", () => {
  const lastRun = {
    dir: "20261013-100000-merge+packages-123",
    at: "2026-10-13T10:00:30.000Z",
    summary: {
      startedAt: "2026-10-13T10:00:00.000Z",
      finishedAt: "2026-10-13T10:00:30.000Z",
      result: "failed",
      error: "构建失败",
      stages: [
        { id: "merge", result: "done", logFile: "01-merge.log", durationMs: 2000, detail: "" },
        { id: "packages", result: "failed", logFile: "02-packages.log", durationMs: 28000, detail: "构建失败" },
      ],
    },
  }

  test("先给出各阶段结果并指出该先看哪个阶段；点开某个阶段才读它的日志", async () => {
    const fetchMock = vi.fn(async () => respond({ lines: ["building…", "boom"], truncated: false }))
    vi.stubGlobal("fetch", fetchMock)
    await act(async () => {
      root.render(<LastRunPanel lastRun={lastRun} />)
    })
    expect(container.textContent).toContain("先看「packages」的日志")
    expect(fetchMock).not.toHaveBeenCalled()
    const buttons = [...container.querySelectorAll("button")]
    await act(async () => {
      buttons[1].click()
    })
    await flush()
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain("/api/stage-log?run=20261013-100000-merge%2Bpackages-123&stage=packages")
    expect(container.textContent).toContain("boom")
    // 没点开的阶段没有读它的日志
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
