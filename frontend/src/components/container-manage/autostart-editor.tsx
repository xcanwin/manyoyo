import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

// 自启动脚本：容器每次启动（新建、重启、machine 重启后再启动）都由容器内的 init 执行；
// 开启下面的开关后，serve 启动时也会把这个容器拉起来。
export function AutostartEditor({
  script,
  onScriptChange,
  onServe,
  onServeChange,
  idPrefix,
}: {
  script: string
  onScriptChange: (script: string) => void
  onServe: boolean
  onServeChange: (value: boolean) => void
  idPrefix: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-autostart`}>自启动脚本（bash）</FieldLabel>
        <Textarea
          id={`${idPrefix}-autostart`}
          className="min-h-28 font-mono text-xs"
          placeholder={"例如：\nnohup python3 -m http.server 8080 &"}
          value={script}
          onChange={(event) => onScriptChange(event.target.value)}
        />
        <FieldDescription>
          容器每次启动后运行一次，输出写入 /run/manyoyo/autostart.log。网络规则下发完成之前不会运行。
        </FieldDescription>
      </Field>
      <Field orientation="horizontal" className="justify-between">
        <FieldLabel htmlFor={`${idPrefix}-autostart-serve`}>serve 启动时自动拉起此容器</FieldLabel>
        <Switch id={`${idPrefix}-autostart-serve`} checked={onServe} onCheckedChange={onServeChange} />
      </Field>
    </div>
  )
}
