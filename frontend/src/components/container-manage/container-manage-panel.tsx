import * as React from "react"
import { PlayIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { AutostartEditor } from "@/components/container-manage/autostart-editor"
import { EnvEditor } from "@/components/container-manage/env-editor"
import { DeniedList } from "@/components/container-manage/denied-list"
import { NetworkEditor } from "@/components/container-manage/network-editor"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { apiDelete, apiErrorData, apiGet, apiPost, apiPut } from "@/lib/api"
import {
  type ContainerEnvState,
  type NetworkPolicy,
  type NetworkState,
  describeNetStatus,
  parseEnvText,
  cleanPolicy,
  samePolicy,
  policyProblems,
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

export function ContainerManagePanel({ containerName }: { containerName: string }) {
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState("")
  const [legacy, setLegacy] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  const [envRevision, setEnvRevision] = React.useState(0)

  const [envState, setEnvState] = React.useState<ContainerEnvState | null>(null)
  const [envText, setEnvText] = React.useState("")
  const [envFiles, setEnvFiles] = React.useState<string[]>([])
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
  const [deniedMessage, setDeniedMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [netSaving, setNetSaving] = React.useState(false)

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
      setEnvFiles(loadedEnv.files.map((file) => file.path))
      setEnvRevision((value) => value + 1)
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

  const envDirty =
    envState !== null &&
    (envText !== envState.text || JSON.stringify(envFiles) !== JSON.stringify(envState.files.map((file) => file.path)))
  const envInvalid = React.useMemo(() => parseEnvText(envText).invalid, [envText])
  const netDirty = net !== null && policy !== null && !samePolicy(cleanPolicy(policy), net.policy)
  const netProblems = net !== null && policy !== null ? policyProblems(policy, net.peers) : []
  const autostartDirty =
    autostart.script !== autostartSaved.script || autostart.autostartOnServe !== autostartSaved.autostartOnServe

  async function saveEnv() {
    if (!envState || envSaving) return
    setEnvSaving(true)
    setEnvMessage(null)
    try {
      const data = await apiPut(`${base}/env`, { text: envText, files: envFiles }, { "If-Match": envState.etag })
      const next = data as unknown as ContainerEnvState
      setEnvState(next)
      setEnvText(next.text)
      setEnvFiles(next.files.map((file) => file.path))
      setEnvRevision((value) => value + 1)
      setEnvMessage({ tone: "ok", text: "已保存。新开的终端和之后的命令立即生效；已打开的终端里执行 reload-env。" })
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
      const toSave = cleanPolicy(policy)
      const risks = policyRisks(net.policy, toSave)
      const prompts: Record<string, { title: string; message: string; confirmLabel: string }> = {
        wide: {
          title: "放开范围很大的规则？",
          message: "新增的允许规则覆盖范围很大（任何地址、内网、云元数据、整个 /8 以上的网段，或类似 *.co.uk 的公共后缀通配），可能让容器越过原有的网络限制。",
          confirmLabel: "确认放开",
        },
        publicBind: {
          title: "让局域网 / 公网可见？",
          message: "端口暴露绑定了 0.0.0.0：能访问到这台机器的任何设备（局域网，服务器在公网时是整个互联网）都可以访问这个宿主机端口，并直达容器里的服务。请确认防火墙已按需限制来源。",
          confirmLabel: "确认暴露",
        },
      }
      for (const risk of risks) {
        if (risk === "custom") continue // 选择「自定义」时已经确认过
        if (!(await confirm(prompts[risk]))) {
          setNetSaving(false)
          return
        }
      }
      let data: Record<string, unknown>
      try {
        data = await putNetwork(toSave, risks.length > 0)
      } catch (error) {
        // 服务端认为还有需要确认的风险（与本地判断不一致时的兜底）：确认后带 confirmRisk 重发
        if (!apiErrorData(error).data.needsConfirm || risks.length > 0) throw error
        const ok = await confirm({
          title: "放开网络限制？",
          message: "这次改动会放开网络限制，确认后才会保存。",
          confirmLabel: "确认放开",
        })
        if (!ok) {
          setNetSaving(false)
          return
        }
        data = await putNetwork(toSave, true)
      }
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

  async function allowDenied(host: string) {
    setDeniedMessage(null)
    try {
      const data = await apiPost(`${base}/network/allow`, { domain: host })
      applyNetwork(data as unknown as NetworkState)
      setDeniedMessage({ tone: "ok", text: `已允许 ${host}，马上生效。` })
    } catch (error) {
      const { data } = apiErrorData(error)
      if (data.policy) applyNetwork(data as unknown as NetworkState)
      setDeniedMessage({ tone: "error", text: error instanceof Error ? error.message : "操作失败" })
    }
  }

  async function clearDenied() {
    setDeniedMessage(null)
    try {
      const data = await apiDelete(`${base}/network/denied`)
      setNet((current) => (current ? { ...current, denied: (data as unknown as NetworkState).denied ?? [] } : current))
    } catch (error) {
      setDeniedMessage({ tone: "error", text: error instanceof Error ? error.message : "操作失败" })
    }
  }

  function applyNetwork(next: NetworkState) {
    setNet(next)
    setPolicy(next.policy)
    setRevision((value) => value + 1)
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
          <p className="text-sm text-muted-foreground">管理容器 {containerName} 的环境变量、网络与自启动，改动不需要重建容器。</p>
          <Button variant="ghost" size="icon-sm" aria-label="重新加载" onClick={() => void load()}>
            <RefreshCwIcon />
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">环境变量</CardTitle>
            <CardDescription>
              保存后下一条命令起生效，已在运行的进程不受影响。容器里也可以直接编辑 /run/manyoyo/env。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <EnvEditor
              key={envRevision}
              value={envText}
              onChange={setEnvText}
              invalid={envInvalid}
              idPrefix="manage"
              files={envFiles}
              onFilesChange={setEnvFiles}
              fileStatus={envState?.files}
            />
            {envState?.warning ? (
              <Alert variant="destructive">
                <AlertDescription>{envState.warning}</AlertDescription>
              </Alert>
            ) : null}
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

        {net && policy ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                网络
                {status ? (
                  <Badge variant={status.tone === "ok" ? "secondary" : status.tone === "danger" ? "destructive" : "outline"}>
                    {status.label}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>规则从上往下匹配，第一条命中的生效；保存后马上生效，不需要重启容器。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <NetworkEditor
                key={revision}
                policy={policy}
                onChange={setPolicy}
                peers={net.peers}
                derived={net.derived}
                forwards={net.forwards}
                suggestedDomains={net.suggestedDomains}
              />
              {net.status?.warning ? (
                <Alert>
                  <AlertDescription>{net.status.warning}</AlertDescription>
                </Alert>
              ) : null}
              {netMessage ? (
                <Alert variant={netMessage.tone === "ok" ? "default" : "destructive"}>
                  <AlertDescription>{netMessage.text}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
            <CardFooter>
              <Button size="sm" disabled={!netDirty || netSaving || netProblems.length > 0} onClick={() => void saveNetwork()}>
                {netSaving ? <Spinner data-icon="inline-start" /> : null}
                保存网络规则
              </Button>
            </CardFooter>
          </Card>
        ) : null}

        {net && (net.policy.preset === "allowlist" || (net.denied ?? []).length > 0) ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">最近被拦截</CardTitle>
              <CardDescription>容器想访问但被拦下的网站。网页打不开、点了没反应时先看这里，点「允许」马上生效。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <DeniedList denied={net.denied ?? []} disabled={netDirty} onAllow={(host) => void allowDenied(host)} />
              {deniedMessage ? (
                <Alert variant={deniedMessage.tone === "ok" ? "default" : "destructive"}>
                  <AlertDescription>{deniedMessage.text}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                刷新
              </Button>
              <Button size="sm" variant="outline" disabled={!(net.denied ?? []).length} onClick={() => void clearDenied()}>
                清空
              </Button>
            </CardFooter>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">自启动</CardTitle>
            <CardDescription>容器新建、重启后都会执行（网络规则下发完成之后才运行）；也可以立即运行一次。</CardDescription>
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
      </div>
      {dialog}
    </div>
  )
}
