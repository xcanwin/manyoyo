import * as React from "react"
import { ExternalLinkIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { AutostartEditor } from "@/components/container-manage/autostart-editor"
import { EnvEditor } from "@/components/container-manage/env-editor"
import { NetworkEditor } from "@/components/container-manage/network-editor"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { apiDelete, apiErrorData, apiGet, apiPost, apiPut } from "@/lib/api"
import {
  type ContainerEnvState,
  type NetworkPolicy,
  type NetworkState,
  describeNetStatus,
  isLoopbackBind,
  parseEnvText,
  policyRisks,
} from "@/lib/container-manage"
import { formatDateTime } from "@/lib/format"

type AutostartState = { script: string; autostartOnServe: boolean }

const enc = (name: string) => encodeURIComponent(name)

function Legacy({ message }: { message?: string }) {
  return (
    <Alert>
      <AlertDescription>{message || "该容器创建于旧版本，重建后可用。"}</AlertDescription>
    </Alert>
  )
}

function exposeUrl(bind: string, hostPort: number): string {
  const host = isLoopbackBind(bind) ? "127.0.0.1" : bind === "0.0.0.0" ? window.location.hostname : bind
  return `http://${host}:${hostPort}/`
}

export function ContainerManagePanel({ containerName }: { containerName: string }) {
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState("")
  const [legacy, setLegacy] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)

  const [envState, setEnvState] = React.useState<ContainerEnvState | null>(null)
  const [envText, setEnvText] = React.useState("")
  const [envMessage, setEnvMessage] = React.useState<{ tone: "ok" | "error" | "conflict"; text: string } | null>(null)
  const [envSaving, setEnvSaving] = React.useState(false)

  const [autostart, setAutostart] = React.useState<AutostartState>({ script: "", autostartOnServe: false })
  const [autostartSaved, setAutostartSaved] = React.useState<AutostartState>({ script: "", autostartOnServe: false })
  const [autostartMessage, setAutostartMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [autostartBusy, setAutostartBusy] = React.useState(false)
  const [log, setLog] = React.useState<string | null>(null)

  const [net, setNet] = React.useState<NetworkState | null>(null)
  const [policy, setPolicy] = React.useState<NetworkPolicy | null>(null)
  const [netMessage, setNetMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [netSaving, setNetSaving] = React.useState(false)

  const [exposeBind, setExposeBind] = React.useState("127.0.0.1")
  const [exposeHostPort, setExposeHostPort] = React.useState("")
  const [exposePort, setExposePort] = React.useState("")
  const [exposeMessage, setExposeMessage] = React.useState("")

  const { confirm, dialog } = useConfirmDialog()
  const base = `/api/containers/${enc(containerName)}`

  const load = React.useCallback(async () => {
    setLoading(true)
    setLoadError("")
    try {
      const [env, auto, network] = await Promise.all([
        apiGet(`${base}/env`),
        apiGet(`${base}/autostart`),
        apiGet(`${base}/network`),
      ])
      if (env.legacy === true) {
        setLegacy(String(env.message || ""))
        return
      }
      setLegacy(null)
      const loadedEnv = env as unknown as ContainerEnvState
      setEnvState(loadedEnv)
      setEnvText(loadedEnv.text)
      setEnvMessage(null)
      const loadedAuto = {
        script: String(auto.script || ""),
        autostartOnServe: auto.autostartOnServe === true,
      }
      setAutostart(loadedAuto)
      setAutostartSaved(loadedAuto)
      setAutostartMessage(null)
      const loadedNet = network as unknown as NetworkState
      setNet(loadedNet)
      setPolicy(loadedNet.policy)
      setNetMessage(null)
      setRevision((value) => value + 1)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [base])

  React.useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const envDirty = envState !== null && envText !== envState.text
  const envInvalid = React.useMemo(() => parseEnvText(envText).invalid, [envText])
  const autostartDirty =
    autostart.script !== autostartSaved.script || autostart.autostartOnServe !== autostartSaved.autostartOnServe

  async function saveEnv() {
    if (!envState || envSaving) return
    setEnvSaving(true)
    setEnvMessage(null)
    try {
      const data = await apiPut(`${base}/env`, { text: envText }, { "If-Match": envState.etag })
      const next = data as unknown as ContainerEnvState
      setEnvState(next)
      setEnvText(next.text)
      setEnvMessage({ tone: "ok", text: "已保存。下一条命令起生效；已在运行的进程不受影响。" })
    } catch (error) {
      const { status, data } = apiErrorData(error)
      if (status === 409 && data.conflict === true) {
        setEnvMessage({ tone: "conflict", text: "容器里的环境变量刚被修改过（比如容器内的脚本改了 /run/manyoyo/env）。" })
      } else {
        setEnvMessage({ tone: "error", text: error instanceof Error ? error.message : "保存失败" })
      }
    } finally {
      setEnvSaving(false)
    }
  }

  async function saveAutostart() {
    if (autostartBusy) return
    setAutostartBusy(true)
    setAutostartMessage(null)
    try {
      const data = await apiPut(`${base}/autostart`, autostart)
      const saved = { script: String(data.script || ""), autostartOnServe: data.autostartOnServe === true }
      setAutostart(saved)
      setAutostartSaved(saved)
      setAutostartMessage({ tone: "ok", text: "已保存，下次容器启动时生效。" })
    } catch (error) {
      setAutostartMessage({ tone: "error", text: error instanceof Error ? error.message : "保存失败" })
    } finally {
      setAutostartBusy(false)
    }
  }

  async function runAutostart() {
    if (autostartBusy) return
    setAutostartBusy(true)
    setAutostartMessage(null)
    try {
      await apiPost(`${base}/autostart/run`, {})
      setAutostartMessage({ tone: "ok", text: "已在容器里启动，稍后刷新日志查看输出。" })
    } catch (error) {
      setAutostartMessage({ tone: "error", text: error instanceof Error ? error.message : "运行失败" })
    } finally {
      setAutostartBusy(false)
    }
  }

  async function refreshLog() {
    try {
      const data = await apiGet(`${base}/autostart/log?tail=16384`)
      setLog(String(data.log || ""))
    } catch (error) {
      setLog(error instanceof Error ? error.message : "读取日志失败")
    }
  }

  async function putNetwork(next: NetworkPolicy, confirmRisk = false) {
    return apiPut(`${base}/network`, { policy: next, confirmRisk })
  }

  async function saveNetwork() {
    if (!net || !policy || netSaving) return
    setNetSaving(true)
    setNetMessage(null)
    try {
      const needsConfirm = policyRisks(net.policy, policy).length > 0
      const data = await putNetwork(policy, needsConfirm)
      applyNetwork(data as unknown as NetworkState)
      setNetMessage({ tone: "ok", text: "已保存并生效（不需要重启容器）。" })
    } catch (error) {
      const { data } = apiErrorData(error)
      if (data.policy) applyNetwork(data as unknown as NetworkState)
      setNetMessage({ tone: "error", text: error instanceof Error ? error.message : "保存失败" })
    } finally {
      setNetSaving(false)
    }
  }

  function applyNetwork(next: NetworkState) {
    setNet(next)
    setPolicy(next.policy)
    setRevision((value) => value + 1)
  }

  async function addExpose() {
    setExposeMessage("")
    const hostPort = Number(exposeHostPort)
    const port = Number(exposePort)
    if (!Number.isInteger(hostPort) || !Number.isInteger(port)) {
      setExposeMessage("请填写两个端口号")
      return
    }
    let confirmRisk = false
    if (!isLoopbackBind(exposeBind)) {
      const ok = await confirm({
        title: "让局域网可见？",
        message: `绑定 ${exposeBind} 后，同一局域网里的任何设备都能访问宿主机的 ${hostPort} 端口，并直达容器里的 ${port} 端口。`,
        confirmLabel: "确认暴露",
      })
      if (!ok) return
      confirmRisk = true
    }
    try {
      const data = await apiPost(`${base}/expose`, { bind: exposeBind, hostPort, port, confirmRisk })
      applyNetwork(data as unknown as NetworkState)
      setExposeHostPort("")
      setExposePort("")
    } catch (error) {
      setExposeMessage(error instanceof Error ? error.message : "添加失败")
    }
  }

  async function removeExpose(bind: string, hostPort: number) {
    setExposeMessage("")
    try {
      const data = await apiDelete(`${base}/expose`, { bind, hostPort })
      applyNetwork(data as unknown as NetworkState)
    } catch (error) {
      setExposeMessage(error instanceof Error ? error.message : "删除失败")
    }
  }

  if (loading && !envState && !legacy) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      </div>
    )
  }
  if (legacy !== null) {
    return (
      <div className="p-4">
        <Legacy message={legacy} />
      </div>
    )
  }

  const status = net ? describeNetStatus(net.status, net.running) : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">管理容器 {containerName} 的环境变量、自启动与网络，改动不需要重建容器。</p>
          <Button variant="ghost" size="icon-sm" aria-label="重新加载" onClick={() => void load()}>
            <RefreshCwIcon />
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">环境变量</CardTitle>
            <CardDescription>
              保存后下一条命令起生效，已在运行的进程不受影响。容器里也可以直接编辑 /run/manyoyo/env。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <EnvEditor value={envText} onChange={setEnvText} invalid={envInvalid} idPrefix="manage" />
            {envState?.mtime ? (
              <p className="text-xs text-muted-foreground">文件最后修改：{formatDateTime(envState.mtime)}</p>
            ) : null}
            {envMessage ? (
              <Alert variant={envMessage.tone === "ok" ? "default" : "destructive"}>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {envMessage.text}
                  {envMessage.tone === "conflict" ? (
                    <Button variant="outline" size="xs" onClick={() => void load()}>
                      重新加载
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button size="sm" disabled={!envDirty || envSaving || envInvalid.length > 0} onClick={() => void saveEnv()}>
              {envSaving ? <Spinner data-icon="inline-start" /> : null}
              保存环境变量
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">自启动</CardTitle>
            <CardDescription>容器新建、重启后都会执行；也可以立即运行一次。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <AutostartEditor
              idPrefix="manage"
              script={autostart.script}
              onScriptChange={(script) => setAutostart((prev) => ({ ...prev, script }))}
              onServe={autostart.autostartOnServe}
              onServeChange={(autostartOnServe) => setAutostart((prev) => ({ ...prev, autostartOnServe }))}
            />
            {autostartMessage ? (
              <Alert variant={autostartMessage.tone === "ok" ? "default" : "destructive"}>
                <AlertDescription>{autostartMessage.text}</AlertDescription>
              </Alert>
            ) : null}
            {log !== null ? (
              <pre className="max-h-60 overflow-auto rounded-lg border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
                {log || "（日志为空）"}
              </pre>
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!autostartDirty || autostartBusy} onClick={() => void saveAutostart()}>
              保存自启动
            </Button>
            <Button size="sm" variant="outline" disabled={autostartBusy || autostartDirty} onClick={() => void runAutostart()}>
              <PlayIcon data-icon="inline-start" />
              立即运行
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refreshLog()}>
              {log === null ? "查看日志" : "刷新日志"}
            </Button>
          </CardFooter>
        </Card>

        {net && policy ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                网络
                {status ? (
                  <Badge variant={status.tone === "ok" ? "secondary" : status.tone === "danger" ? "destructive" : "outline"}>
                    {status.label}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>规则保存后 2 秒内生效，容器不需要重启。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <NetworkEditor key={revision} idPrefix="manage" policy={policy} onChange={setPolicy} peers={net.peers} />
              {netMessage ? (
                <Alert variant={netMessage.tone === "ok" ? "default" : "destructive"}>
                  <AlertDescription>{netMessage.text}</AlertDescription>
                </Alert>
              ) : null}
              <div>
                <Button size="sm" disabled={netSaving} onClick={() => void saveNetwork()}>
                  {netSaving ? <Spinner data-icon="inline-start" /> : null}
                  保存网络规则
                </Button>
              </div>

              <div className="flex flex-col gap-2 border-t pt-4">
                <p className="text-sm font-medium">端口暴露</p>
                <p className="text-xs text-muted-foreground">
                  把容器端口映射到宿主机，立即生效、无需重启；serve 重启后自动恢复。绑定 0.0.0.0 等于局域网可见。
                </p>
                {net.policy.expose.map((entry) => (
                  <div key={`${entry.bind}:${entry.hostPort}`} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs">
                      {entry.bind}:{entry.hostPort} → {entry.port}
                    </span>
                    <a
                      className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                      href={exposeUrl(entry.bind, entry.hostPort)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开
                      <ExternalLinkIcon className="size-3" />
                    </a>
                    <Button
                      className="ml-auto"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除这条暴露"
                      onClick={() => void removeExpose(entry.bind, entry.hostPort)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-end gap-2">
                  <Field className="w-36">
                    <FieldLabel htmlFor="expose-bind">监听地址</FieldLabel>
                    <Select value={exposeBind} onValueChange={(value) => value && setExposeBind(value)}>
                      <SelectTrigger id="expose-bind" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="127.0.0.1">127.0.0.1</SelectItem>
                          <SelectItem value="0.0.0.0">0.0.0.0（局域网）</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="w-28">
                    <FieldLabel htmlFor="expose-host-port">宿主机端口</FieldLabel>
                    <Input
                      id="expose-host-port"
                      inputMode="numeric"
                      placeholder="18080"
                      value={exposeHostPort}
                      onChange={(event) => setExposeHostPort(event.target.value)}
                    />
                  </Field>
                  <Field className="w-28">
                    <FieldLabel htmlFor="expose-port">容器端口</FieldLabel>
                    <Input
                      id="expose-port"
                      inputMode="numeric"
                      placeholder="8080"
                      value={exposePort}
                      onChange={(event) => setExposePort(event.target.value)}
                    />
                  </Field>
                  <Button variant="outline" size="sm" onClick={() => void addExpose()}>
                    <PlusIcon data-icon="inline-start" />
                    添加
                  </Button>
                </div>
                {exposeMessage ? (
                  <Alert variant="destructive">
                    <AlertDescription>{exposeMessage}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
      {dialog}
    </div>
  )
}
