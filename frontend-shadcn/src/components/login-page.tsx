import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>MANYOYO Web</CardTitle>
          <CardDescription>shadcn/ui 预览版 · 请登录后继续</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-username">用户名</FieldLabel>
                <Input
                  id="login-username"
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="login-password">密码</FieldLabel>
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
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "登录中..." : "登录"}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
