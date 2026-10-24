import * as React from "react"
import { CheckIcon, FolderIcon } from "lucide-react"

import { DirectoryPickerDialog } from "@/components/directory-picker-dialog"
import { DoctorPanel } from "@/components/doctor-panel"
import { MirrorSettings } from "@/components/mirror-settings"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  AGENT_BLURBS,
  buildEnvBody,
  connectionNotice,
  createAgentSession,
  fetchSetupAgents,
  baseUrlPlaceholder,
  AGENT_UNAVAILABLE_HINT,
  isAgentUnavailable,
  fetchSetupStatus,
  getDirectoryHint,
  getReadiness,
  passwordStrength,
  retrySetupRuntime,
  saveAgent,
  savePassword,
  testConnection,
  validatePassword,
  validateStep,
  type AccessMode,
  type ConnectionResult,
  type SetupAgent,
  type SetupForm,
  type SetupStatus,
} from "@/lib/setup"
import {
  emptyMirrors,
  emptyPresets,
  fetchMirrorPresets,
  isMirrorsEmpty,
  saveMirrors,
  validateMirrors,
  type MirrorPresets,
  type Mirrors,
} from "@/lib/mirrors"

import { Hint } from "@/components/hint"
const STEP_TITLES = ["选择 Agent", "接入方式", "工作目录", "保存并开始"]
const POLL_INTERVAL_MS = 2000

const MODES: { id: AccessMode; label: string; disabled?: boolean }[] = [
  { id: "official", label: "官方 API Key" },
  { id: "compatible", label: "兼容服务" },
  { id: "subscription", label: "订阅登录" },
]

const STATE_LABEL = { done: "已就绪", doing: "准备中", waiting: "等待中", failed: "失败" } as const

export function SetupWizard({
  onFinished,
  onSkip,
}: {
  onFinished: (containerName: string) => void
  onSkip: () => void
}) {
  const [agents, setAgents] = React.useState<SetupAgent[]>([])
  const [status, setStatus] = React.useState<SetupStatus | null>(null)
  const [step, setStep] = React.useState<1 | 2 | 3 | 4>(1)
  const [form, setForm] = React.useState<SetupForm>({
    agentId: "",
    mode: "official",
    apiKey: "",
    baseUrl: "",
    model: "",
    hostPath: "",
  })
  const [error, setError] = React.useState("")
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<ConnectionResult | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [passwordConfirm, setPasswordConfirm] = React.useState("")
  const [showDoctor, setShowDoctor] = React.useState(false)
  // 软件源（可选）：不碰就是官方默认，也不会写任何配置
  const [mirrors, setMirrors] = React.useState<Mirrors>(emptyMirrors())
  const [mirrorsTouched, setMirrorsTouched] = React.useState(false)
  const [mirrorPresets, setMirrorPresets] = React.useState<MirrorPresets>(emptyPresets())
  const [mirrorsOpen, setMirrorsOpen] = React.useState(false)

  const readiness = getReadiness(status)
  const agent = agents.find((item) => item.id === form.agentId) ?? null
  const selectedProvider = agent?.providers?.find((item) => item.id === form.providerId) ?? null
  const hostPath = form.hostPath || status?.defaultHostPath || ""
  const effectiveForm: SetupForm = { ...form, hostPath }
  // 后台启动的服务密码是自动生成、用户看不到的；没设置过就在保存前要求设置一个
  const needsPassword = status?.passwordSet === false

  // 镜像就绪后要再取一次：就绪前 available 是未知（null），就绪后才知道哪些 CLI 没装
  const imageReady = status?.image.status === "ready"
  React.useEffect(() => {
    let cancelled = false
    fetchSetupAgents()
      .then((list) => {
        if (cancelled) return
        setAgents(list)
        // 已选中的 Agent 变成不可用时清空选择
        setForm((prev) => (list.some((item) => item.id === prev.agentId && isAgentUnavailable(item)) ? { ...prev, agentId: "" } : prev))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载 Agent 列表失败")
      })
    return () => {
      cancelled = true
    }
  }, [imageReady])

  React.useEffect(() => {
    let cancelled = false
    fetchMirrorPresets()
      .then((list) => {
        if (!cancelled) setMirrorPresets(list)
      })
      .catch(() => {
        // 拿不到预设时下拉里只有“官方默认”和“自定义”
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 已经配置过的软件源带出来，用户没动之前以服务端为准
  const configuredMirrors = status?.mirrors
  const effectiveMirrors: Mirrors = mirrorsTouched ? mirrors : { ...emptyMirrors(), ...configuredMirrors }

  // 就绪前持续轮询 status 刷新进度条；就绪后停止
  const ready = readiness.ready
  React.useEffect(() => {
    if (ready) return
    let cancelled = false
    const tick = () =>
      fetchSetupStatus()
        .then((next) => {
          if (!cancelled) setStatus(next)
        })
        .catch(() => {
          // 轮询失败时保持上一份状态，下个周期再试
        })
    queueMicrotask(tick)
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [ready])

  function setField<K extends keyof SetupForm>(key: K, value: SetupForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value, ...(key === "agentId" ? { keyEnv: "", providerId: "", extraEnv: undefined } : {}) }))
    if (key !== "hostPath") setTestResult(null)
  }

  function handleNext() {
    if (step === 4) return
    const message = validateStep(step, effectiveForm, agent)
    if (message) {
      setError(message)
      return
    }
    setError("")
    setStep((step + 1) as 2 | 3 | 4)
  }

  function handleBack() {
    setError("")
    if (step > 1) setStep((step - 1) as 1 | 2 | 3)
  }

  async function handleTest() {
    if (!agent || testing || !readiness.ready) return
    const message = validateStep(2, effectiveForm, agent)
    if (message) {
      setError(message)
      return
    }
    setError("")
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testConnection(agent.id, buildEnvBody(agent, effectiveForm)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试连接失败")
    } finally {
      setTesting(false)
    }
  }

  async function handleFinish() {
    if (!agent || saving || !readiness.ready) return
    if (needsPassword) {
      const message = validatePassword(password, passwordConfirm)
      if (message) {
        setError(message)
        return
      }
    }
    if (mirrorsTouched) {
      const mirrorMessage = validateMirrors(effectiveMirrors)
      if (mirrorMessage) {
        setError(mirrorMessage)
        return
      }
    }
    setSaving(true)
    setError("")
    try {
      if (mirrorsTouched && (!isMirrorsEmpty(effectiveMirrors) || configuredMirrors)) {
        await saveMirrors(effectiveMirrors)
      }
      if (needsPassword) {
        await savePassword(password)
        setStatus((prev) => (prev ? { ...prev, passwordSet: true } : prev))
      }
      await saveAgent(agent.id, buildEnvBody(agent, effectiveForm), effectiveForm.hostPath)
      onFinished(await createAgentSession(agent.id, effectiveForm.hostPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
      setSaving(false)
    }
  }

  const directoryHint = getDirectoryHint(hostPath, status)

  return (
    <div className="flex min-h-svh items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">MANYOYO</h1>
          <p className="text-sm text-muted-foreground">第一次使用，先接入一个 Agent</p>
        </div>

        <Card size="sm" data-testid="setup-readiness">
          <CardContent className="flex flex-col gap-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.max(readiness.percent, 5)}%` }}
                role="progressbar"
                aria-valuenow={readiness.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {readiness.items.map((item) => (
                <span key={item.key} className="flex items-center gap-1">
                  {item.state === "doing" ? <Spinner className="size-3" /> : null}
                  {item.state === "done" ? <CheckIcon className="size-3" /> : null}
                  {item.label}：{STATE_LABEL[item.state]}
                </span>
              ))}
            </div>
            {!readiness.ready && readiness.blockedReason ? (
              <Hint className="block">{readiness.blockedReason}（完成前可先填写前三步）</Hint>
            ) : null}
            {readiness.items.some((item) => item.state === "failed") ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      void retrySetupRuntime().then(() => fetchSetupStatus().then(setStatus)).catch(() => {})
                    }}
                  >
                    重试
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowDoctor((prev) => !prev)}>
                    {showDoctor ? "收起环境检查" : "检查环境"}
                  </Button>
                </div>
                {showDoctor ? <DoctorPanel /> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              第 {step} / 4 步 · {STEP_TITLES[step - 1]}
            </CardTitle>
            <CardDescription>
              {step === 1 ? "选择你想在沙箱里运行的 Agent" : null}
              {step === 2 ? "填写访问模型服务所需的 Key，Key 只保存在本机配置里" : null}
              {step === 3 ? "Agent 只能看到你在这里选择的目录" : null}
              {step === 4 ? (needsPassword ? "确认信息并设置登录密码，保存后直接进入会话" : "确认信息，保存后直接进入会话") : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {step === 1 ? (
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Agent">
                {agents.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={form.agentId === item.id}
                    disabled={isAgentUnavailable(item)}
                    onClick={() => setField("agentId", item.id)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors hover:bg-muted",
                      form.agentId === item.id && "border-primary bg-muted",
                      isAgentUnavailable(item) && "cursor-not-allowed opacity-50 hover:bg-transparent"
                    )}
                  >
                    <span className="text-sm font-medium">{item.label}</span>
                    <Hint>
                      {isAgentUnavailable(item) ? AGENT_UNAVAILABLE_HINT : (AGENT_BLURBS[item.id] ?? "")}
                    </Hint>
                  </button>
                ))}
                {agents.length === 0 && !error ? <Spinner className="mx-auto my-4" /> : null}
              </div>
            ) : null}

            {step === 2 && agent ? (
              <FieldGroup className="gap-4">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="接入方式">
                  {MODES.map((mode) => (
                    <Button
                      key={mode.id}
                      type="button"
                      role="radio"
                      aria-checked={form.mode === mode.id}
                      variant={form.mode === mode.id ? "default" : "outline"}
                      disabled={mode.disabled}
                      onClick={() => setField("mode", mode.id)}
                    >
                      {mode.label}
                      {mode.disabled ? <Badge variant="secondary">即将支持</Badge> : null}
                    </Button>
                  ))}
                </div>

                {form.mode === "compatible" ? (
                  <Field>
                    <FieldLabel htmlFor="setup-base-url">Base URL</FieldLabel>
                    <Input
                      id="setup-base-url"
                      inputMode="url"
                      placeholder={baseUrlPlaceholder(agent)}
                      value={form.baseUrl}
                      onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value, keyEnv: "", providerId: "", extraEnv: undefined }))}
                    />
                    {(agent.providers ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-2" role="group" aria-label="服务商">
                        {(agent.providers ?? []).map((provider) => (
                          <Button
                            key={provider.id}
                            type="button"
                            size="xs"
                            variant={form.providerId === provider.id ? "default" : "outline"}
                            onClick={() => {
                              setTestResult(null)
                              setForm((prev) => ({
                                ...prev,
                                baseUrl: provider.baseUrl,
                                keyEnv: provider.keyEnv,
                                providerId: provider.id,
                                extraEnv: provider.extraEnv,
                                model: provider.defaultModel && !prev.model.trim() ? provider.defaultModel : prev.model,
                              }))
                            }}
                          >
                            {provider.label}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    {selectedProvider ? (
                      <FieldDescription>
                        <a href={selectedProvider.docUrl} target="_blank" rel="noopener noreferrer" className="underline">
                          官方说明
                        </a>
                      </FieldDescription>
                    ) : null}
                    {agent.baseUrlPresets.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {agent.baseUrlPresets.map((preset) => (
                          <Button
                            key={preset.value}
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => setForm((prev) => ({ ...prev, baseUrl: preset.value, keyEnv: "", providerId: "", extraEnv: undefined }))}
                          >
                            {preset.label}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    <FieldDescription>可选预设，也可以直接填写自建或第三方兼容服务的地址。</FieldDescription>
                  </Field>
                ) : null}

                {form.mode === "subscription" && agent.id !== "claude" ? (
                  <Alert>
                    <AlertDescription>
                      Codex CLI 的订阅登录要在容器里完成：先选其它接入方式建好会话，再在容器的终端里运行 codex login --device-auth，按提示用浏览器登录。登录只在那个容器里有效，换容器要重新登录。
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {form.mode === "subscription" ? (
                      <Alert>
                        <AlertDescription>
                          在任意有浏览器的电脑上运行 claude setup-token，把得到的长期令牌粘贴到下面；也可以建好会话后，在容器的终端里运行 claude 按提示登录（凭据只在那个容器里）。
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor="setup-api-key">{form.mode === "subscription" ? "订阅令牌" : "API Key"}</FieldLabel>
                      <Input
                        id="setup-api-key"
                        type="password"
                        autoComplete="off"
                        placeholder={form.mode === "subscription" ? "粘贴订阅令牌（不会回显）" : "粘贴你的 Key（不会回显）"}
                        value={form.apiKey}
                        onChange={(event) => setField("apiKey", event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="setup-model">模型（可选）</FieldLabel>
                      <Input
                        id="setup-model"
                        placeholder={form.mode === "compatible" && selectedProvider?.models[0] ? `例如 ${selectedProvider.models[0]}` : "留空使用 Agent 默认模型"}
                        value={form.model}
                        onChange={(event) => setField("model", event.target.value)}
                      />
                    </Field>
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!readiness.ready || testing}
                        onClick={handleTest}
                        className="self-start"
                      >
                        {testing ? <Spinner data-icon="inline-start" /> : null}
                        测试连接
                      </Button>
                      {!readiness.ready ? (
                        <Hint className="block">{readiness.blockedReason}，就绪后可测试连接</Hint>
                      ) : null}
                      {testResult ? (
                        <Alert
                          variant={connectionNotice(testResult).tone === "error" ? "destructive" : "default"}
                          data-tone={connectionNotice(testResult).tone}
                          // 成功提示用绿色：测试连接要等一会儿，用户需要一眼看出“通过了”
                          className={cn(
                            connectionNotice(testResult).tone === "success" &&
                              "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 *:data-[slot=alert-description]:text-emerald-700 dark:text-emerald-400 dark:*:data-[slot=alert-description]:text-emerald-400"
                          )}
                        >
                          <AlertDescription>
                            {connectionNotice(testResult).text}
                            {testResult.category !== "success" && testResult.detail ? (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs">详情</summary>
                                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                                  {testResult.detail}
                                </pre>
                              </details>
                            ) : null}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  </>
                )}
              </FieldGroup>
            ) : null}

            {step === 3 ? (
              <FieldGroup className="gap-3">
                <Field>
                  <FieldLabel htmlFor="setup-host-path">工作目录</FieldLabel>
                  <div className="flex gap-2">
                    <Input id="setup-host-path" value={hostPath} readOnly />
                    <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                      <FolderIcon data-icon="inline-start" />
                      选择
                    </Button>
                  </div>
                  <FieldDescription>默认使用专用的工作目录，也可以改成你的项目目录。</FieldDescription>
                </Field>
                {directoryHint ? (
                  <Alert>
                    <AlertDescription>{directoryHint}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-col gap-2" data-testid="setup-mirrors">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    aria-expanded={mirrorsOpen}
                    onClick={() => setMirrorsOpen((open) => !open)}
                  >
                    软件源（可选）{mirrorsOpen ? "：收起" : "：默认官方源，点此修改"}
                  </Button>
                  {mirrorsOpen ? (
                    <>
                      <Hint className="block">
                        容器里安装软件用的 apt / npm / pip 源。不改就用官方默认源；网络慢时可选镜像加速，只对之后新建的容器生效。
                      </Hint>
                      <MirrorSettings
                        mirrors={effectiveMirrors}
                        presets={mirrorPresets}
                        onChange={(next) => {
                          setMirrors(next)
                          setMirrorsTouched(true)
                        }}
                        idPrefix="setup-mirror"
                      />
                    </>
                  ) : null}
                </div>
              </FieldGroup>
            ) : null}

            {step === 4 && agent ? (
              <div className="flex flex-col gap-3">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Agent</dt>
                  <dd>{agent.label}</dd>
                  <dt className="text-muted-foreground">接入方式</dt>
                  <dd>{MODES.find((mode) => mode.id === form.mode)?.label}</dd>
                  {form.mode === "compatible" ? (
                    <>
                      <dt className="text-muted-foreground">Base URL</dt>
                      <dd className="break-all">{form.baseUrl}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">工作目录</dt>
                  <dd className="break-all">{hostPath}</dd>
                </dl>
                {needsPassword ? (
                  <FieldGroup className="gap-3">
                    <Field>
                      <FieldLabel htmlFor="setup-password">登录密码</FieldLabel>
                      <Input
                        id="setup-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="至少 8 位"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      {password ? (
                        <FieldDescription data-testid="password-strength">{passwordStrength(password).label}</FieldDescription>
                      ) : null}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="setup-password-confirm">再输入一次</FieldLabel>
                      <Input
                        id="setup-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        value={passwordConfirm}
                        onChange={(event) => setPasswordConfirm(event.target.value)}
                      />
                      <FieldDescription>
                        用于以后从其他浏览器或设备、或登出后登录，用户名是 {status?.serverUser || "admin"}。本机上执行 manyoyo 仍会自动登录。
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                ) : null}
                {!readiness.ready ? (
                  <Hint className="block">{readiness.blockedReason}，就绪后可保存并进入</Hint>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onSkip}>
                  跳过向导
                </Button>
                {step > 1 ? (
                  <Button type="button" variant="outline" onClick={handleBack}>
                    上一步
                  </Button>
                ) : null}
              </div>
              {step < 4 ? (
                <Button type="button" onClick={handleNext}>
                  下一步
                </Button>
              ) : (
                <Button type="button" disabled={!readiness.ready || saving} onClick={handleFinish}>
                  {saving ? <Spinner data-icon="inline-start" /> : null}
                  保存并进入
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <DirectoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={hostPath}
        onSelect={(path) => {
          setField("hostPath", path)
          setPickerOpen(false)
        }}
      />
    </div>
  )
}
