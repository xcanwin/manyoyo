import * as React from "react"

import { apiGet } from "@/lib/api"
import {
  CUSTOM_VERSION,
  DEFAULT_VERSION,
  imageNameOptions,
  versionAfterNameChange,
  versionsOf,
  type LocalImage,
} from "@/lib/image-options"
import {
  DEFAULT_CONTAINER_NAME_TEMPLATE,
  DEFAULT_PATH_TEMPLATE,
} from "@/lib/name-template"
import { Hint } from "@/components/hint"
import { KeyLabel } from "@/components/key-label"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Commit = (path: string[], valueText: string, jsValue: unknown) => void
type ImagesInfo = {
  defaults: { imageName: string; imageVersion: string }
  images: LocalImage[]
}

const CONTAINER_MODES: Array<{ value: string; label: string }> = [
  { value: "", label: "默认（common 标准容器）" },
  { value: "common", label: "common：标准容器" },
  { value: "dind", label: "dind：容器里跑 Docker（特权）" },
  { value: "sock", label: "sock：可访问宿主机 Docker（有安全风险）" },
]

// 留空 = 用默认值：配置里原来没有的字段不会因为留空被写进去
// defaultValue：配置里没写时显示的默认内容（只是显示，没改动就不会写进配置）
function TextSetting({
  k,
  value,
  defaultValue = "",
  placeholder,
  description,
  onCommit,
}: {
  k: string
  value: string
  defaultValue?: string
  placeholder: string
  description?: string
  onCommit: Commit
}) {
  const [text, setText] = React.useState(value || defaultValue)
  const id = `config-field-${k}`
  return (
    <Field>
      <KeyLabel k={k} htmlFor={id} />
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value)
          onCommit([k], JSON.stringify(event.target.value), event.target.value)
        }}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}

// 镜像名与版本是一对：名字是可输入的（带本机镜像候选），版本是下拉（只列这个镜像在本机有的版本），
// 本机没有的版本 / 还没拉取的镜像选“其它版本”手填。换成本机已有的另一个镜像时，版本跟着换成它最新的
function ImageSettings({
  name,
  version,
  info,
  onCommit,
}: {
  name: string
  version: string
  info: ImagesInfo | null
  onCommit: Commit
}) {
  const [nameText, setNameText] = React.useState(name)
  const [versionText, setVersionText] = React.useState(version)
  const [customMode, setCustomMode] = React.useState(false)
  const images = info?.images ?? []
  const defaults = info?.defaults ?? { imageName: "", imageVersion: "" }
  const names = imageNameOptions(images, defaults.imageName, nameText)
  const tags = versionsOf(images, nameText.trim(), defaults.imageName)
  const knownVersion = tags.some((item) => item.tag === versionText)
  const showInput =
    tags.length === 0 || customMode || (versionText !== "" && !knownVersion)
  const effectiveName = nameText.trim() || defaults.imageName

  function commitName(next: string) {
    setNameText(next)
    onCommit(["imageName"], JSON.stringify(next), next)
    const follow = versionAfterNameChange(images, next.trim(), versionText)
    if (follow !== undefined) {
      setVersionText(follow)
      setCustomMode(false)
      onCommit(["imageVersion"], JSON.stringify(follow), follow)
    }
  }

  function commitVersion(next: string) {
    setVersionText(next)
    onCommit(["imageVersion"], JSON.stringify(next), next)
  }

  const defaultLabel =
    effectiveName === defaults.imageName && defaults.imageVersion
      ? `默认（${defaults.imageVersion}）`
      : "默认"
  const labelOf = (value: string) => {
    if (value === DEFAULT_VERSION) return defaultLabel
    if (value === CUSTOM_VERSION) return "其它版本…"
    const hit = tags.find((item) => item.tag === value)
    return hit ? hit.tag : value
  }

  return (
    <>
      <Field>
        <KeyLabel k="imageName" htmlFor="config-field-imageName" />
        <Input
          id="config-field-imageName"
          list="config-image-names"
          value={nameText}
          placeholder={defaults.imageName || "例如 ghcr.io/xcanwin/manyoyo"}
          onChange={(event) => commitName(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <datalist id="config-image-names">
          {names.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <FieldDescription>
          可以直接输入，也可以从本机已有的镜像里选；留空用默认镜像。
        </FieldDescription>
      </Field>
      <Field>
        <KeyLabel k="imageVersion" htmlFor="config-field-imageVersion" />
        {tags.length > 0 ? (
          <Select
            value={showInput ? CUSTOM_VERSION : versionText || DEFAULT_VERSION}
            onValueChange={(value) => {
              if (value === CUSTOM_VERSION) {
                setCustomMode(true)
                return
              }
              setCustomMode(false)
              commitVersion(value === DEFAULT_VERSION ? "" : String(value))
            }}
          >
            <SelectTrigger
              id="config-field-imageVersion-select"
              className="w-full"
              aria-label="镜像版本"
            >
              <SelectValue>{(value: string) => labelOf(value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={DEFAULT_VERSION}>{defaultLabel}</SelectItem>
                {tags.map((item) => (
                  <SelectItem key={item.tag} value={item.tag}>
                    {item.tag}
                    <Hint className="ml-2">
                      {[item.created, item.size].filter(Boolean).join(" · ")}
                    </Hint>
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VERSION}>其它版本…</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        {showInput ? (
          <Input
            id="config-field-imageVersion"
            value={versionText}
            placeholder={
              defaults.imageVersion
                ? `例如 ${defaults.imageVersion}`
                : "例如 2.3.0-common"
            }
            onChange={(event) => commitVersion(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        ) : null}
        <FieldDescription>
          {tags.length > 0
            ? "列出的是这个镜像在本机已有的版本；留空用默认版本。本机没有的版本选「其它版本」手填，首次使用会自动拉取。"
            : "本机没有找到这个镜像的版本，可以直接填写（格式 x.y.z-后缀），首次使用会自动拉取；留空用默认版本。"}
        </FieldDescription>
      </Field>
    </>
  )
}

// 系统设置「基础」：新容器的默认值。配置里没写的字段也能直接填（留空 = 用默认值）
export function BasicSettings({
  liveParsed,
  onCommit,
}: {
  liveParsed: Record<string, unknown>
  onCommit: Commit
}) {
  const [info, setInfo] = React.useState<ImagesInfo | null>(null)
  const str = (key: string) =>
    typeof liveParsed[key] === "string" ? (liveParsed[key] as string) : ""
  const [mode, setMode] = React.useState(str("containerMode"))

  React.useEffect(() => {
    let cancelled = false
    apiGet("/api/images")
      .then((data) => {
        if (!cancelled) setInfo(data as unknown as ImagesInfo)
      })
      .catch(() => {
        // 拿不到本机镜像列表时，镜像名和版本都退回成可直接输入
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="基础"
        description="新建容器时的默认值，留空就用默认。"
      />
      <Card>
        <CardContent>
          <FieldGroup>
            <TextSetting
              k="containerName"
              value={str("containerName")}
              defaultValue={DEFAULT_CONTAINER_NAME_TEMPLATE}
              placeholder={DEFAULT_CONTAINER_NAME_TEMPLATE}
              description="网页新建容器时的默认容器名；命令行没写时用 my-加时间。{now} 会换成当前时间（年月日-时分秒，如 20261024-230915）。"
              onCommit={onCommit}
            />
            <TextSetting
              k="hostPath"
              value={str("hostPath")}
              defaultValue={DEFAULT_PATH_TEMPLATE}
              placeholder={DEFAULT_PATH_TEMPLATE}
              description="挂进容器的宿主机目录。{quickChatPath} 是快捷对话的工作目录（没设置就是 ~/.manyoyo/work）；按模板生成的目录在创建时才会建。命令行没写时用当前目录。"
              onCommit={onCommit}
            />
            <TextSetting
              k="containerPath"
              value={str("containerPath")}
              defaultValue={DEFAULT_PATH_TEMPLATE}
              placeholder={DEFAULT_PATH_TEMPLATE}
              description="容器里看到的目录，写法同宿主机目录；清空则与宿主机目录相同。"
              onCommit={onCommit}
            />
            <ImageSettings
              name={str("imageName")}
              version={str("imageVersion")}
              info={info}
              onCommit={onCommit}
            />
            <Field>
              <KeyLabel
                k="containerMode"
                htmlFor="config-field-containerMode"
              />
              <Select
                value={mode}
                onValueChange={(value) => {
                  const next = String(value ?? "")
                  setMode(next)
                  onCommit(["containerMode"], JSON.stringify(next), next)
                }}
              >
                <SelectTrigger
                  id="config-field-containerMode"
                  className="w-full"
                  aria-label="容器模式"
                >
                  <SelectValue>
                    {(value: string) =>
                      CONTAINER_MODES.find((item) => item.value === value)
                        ?.label ?? value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CONTAINER_MODES.map((item) => (
                      <SelectItem
                        key={item.value || "default"}
                        value={item.value}
                      >
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}
