import { describe, expect, it } from "vitest"

import type { SessionSummary } from "@/lib/api"
import { buildSessionHash, parseSessionHash, pickMostRecentSession } from "@/lib/session-url"

function make(name: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { name, updatedAt: null, ...extra } as SessionSummary
}

describe("session-url", () => {
  it("hash 往返", () => {
    expect(parseSessionHash(buildSessionHash("a/b c"))).toBe("a/b c")
    expect(parseSessionHash("")).toBeNull()
    expect(parseSessionHash("#%E0%A4%A")).toBeNull()
    expect(buildSessionHash(null)).toBe("")
  })

  it("选最近更新的真实 AGENT", () => {
    const list = [
      make("old", { updatedAt: "2026-01-01T00:00:00Z" }),
      make("new", { updatedAt: "2026-02-01T00:00:00Z" }),
      make("syn", { updatedAt: "2026-03-01T00:00:00Z", synthetic: true }),
      make("stopped", { updatedAt: "2026-04-01T00:00:00Z", archived: true }),
    ]
    expect(pickMostRecentSession(list)?.name).toBe("new")
    expect(pickMostRecentSession([])).toBeNull()
  })
})
