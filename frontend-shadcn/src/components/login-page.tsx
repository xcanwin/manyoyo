import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const REDIRECT_TARGET = "/shadcn"

export function LoginPage() {
  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [checkingSession, setCheckingSession] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    fetch("/api/sessions", { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then((response) => {
        if (!cancelled && response.ok) {
          window.location.href = REDIRECT_TARGET
          return
        }
        if (!cancelled) {
          setCheckingSession(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCheckingSession(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setError("")
    setSubmitting(true)
    try {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload.error || "登录失败")
      }
      window.location.href = REDIRECT_TARGET
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败")
      setSubmitting(false)
    }
  }

  if (checkingSession) {
    return <div className="flex min-h-svh items-center justify-center" />
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden p-6">
      {/* 极淡的网格背景 + 卡片后方的柔光，呼应"终端/开发者工具"调性，同时不引入品牌色以外的新色板 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute top-1/4 left-1/2 -z-10 size-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl"
        aria-hidden
      />

      {/* 标题块用 absolute 从正常流里摘出来，浮在卡片上方——这样外层 items-center 只按卡片自身
          高度居中，卡片才会落在视口正中央，不会被上面的标题块一起拖累偏下 */}
      <div className="relative w-full max-w-sm">
        <div className="absolute inset-x-0 bottom-full mb-6 flex flex-col items-center gap-1.5 text-center">
          <span className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
            Agent Sandbox Console
          </span>
          <h1 className="font-mono text-4xl font-semibold tracking-tight text-foreground">MANYOYO</h1>
          <p className="text-sm text-muted-foreground">AI Agent 容器安全沙箱 · 安全隔离运行</p>
        </div>

        <Card className="w-full gap-0 py-0 shadow-lg">
          <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-destructive/70" />
            <span className="size-2.5 rounded-full bg-amber-500/70" />
            <span className="size-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <CardContent className="px-6 py-6">
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel
                    htmlFor="login-username"
                    className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
                  >
                    用户名
                  </FieldLabel>
                  <Input
                    id="login-username"
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      document.getElementById("login-password")?.focus()
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor="login-password"
                    className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
                  >
                    密码
                  </FieldLabel>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                  {submitting ? "登录中..." : "登录"}
                  {!submitting ? <ChevronRightIcon data-icon="inline-end" /> : null}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
