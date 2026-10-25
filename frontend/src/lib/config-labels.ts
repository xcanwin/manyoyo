// 系统设置表单里 JSON 键名 → 中文名与说明。没登记的键退回键名本身，不影响功能。
const LABELS: Record<string, { title: string; desc?: string }> = {
  serverUser: { title: "登录用户名" },
  serverPass: { title: "登录密码", desc: "网页登录用，已设置时不回显，留空则保持不变。" },
  serve: { title: "网页服务", desc: "网页界面自身的行为。" },
  title: { title: "网页标题", desc: "留空则按当前 AGENT 动态显示。" },
  quickChat: { title: "快捷对话", desc: "点「快捷对话」时使用的运行配置和工作目录。" },
  run: { title: "运行配置", desc: "使用 runs 里的哪一项。" },
  path: { title: "工作目录" },
  env: { title: "环境变量" },
  envFile: { title: "环境变量文件" },
  volumes: { title: "挂载目录" },
  ports: { title: "端口映射" },
  first: { title: "首次启动" },
  shellPrefix: { title: "命令前缀" },
  shell: { title: "命令" },
  shellSuffix: { title: "命令后缀" },
  agentPromptCommand: { title: "Agent 对话命令" },
  yolo: { title: "YOLO 模式" },
  quiet: { title: "安静模式" },
  containerName: { title: "容器名" },
  hostPath: { title: "宿主机目录" },
  containerPath: { title: "容器内目录" },
  imageName: { title: "镜像名" },
  imageVersion: { title: "镜像版本" },
  containerMode: { title: "容器模式" },
  imageBuildArgs: { title: "构建参数" },
  plugins: { title: "插件" },
}

// 常见环境变量名的中文名（运行配置页、设置容器页的环境变量表、模型服务页共用的唯一数据源）。
// 没登记的变量名原样等宽显示。
export const ENV_LABELS: Record<string, string> = {
  ANTHROPIC_BASE_URL: "Claude 服务地址",
  ANTHROPIC_AUTH_TOKEN: "Claude 访问令牌",
  ANTHROPIC_API_KEY: "Claude Key",
  CLAUDE_CODE_OAUTH_TOKEN: "Claude 订阅令牌",
  ANTHROPIC_MODEL: "Claude 模型",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "Claude 大模型（Opus）",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "Claude 中模型（Sonnet）",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "Claude 小模型（Haiku）",
  ANTHROPIC_SMALL_FAST_MODEL: "Claude 快速模型",
  OPENAI_BASE_URL: "Codex 服务地址",
  OPENAI_API_KEY: "Codex Key",
  OPENAI_MODEL: "Codex 模型",
  GEMINI_API_KEY: "Gemini Key",
  GOOGLE_GEMINI_BASE_URL: "Gemini 服务地址",
  GEMINI_MODEL: "Gemini 模型",
  ENABLE_TOOL_SEARCH: "关闭工具搜索",
  API_TIMEOUT_MS: "接口超时（毫秒）",
  HTTP_PROXY: "HTTP 代理",
  HTTPS_PROXY: "HTTPS 代理",
  ALL_PROXY: "全部流量代理",
  NO_PROXY: "不走代理的地址",
}

/** 变量名的中文名；没登记返回 undefined。代理变量大小写都认 */
export function envLabel(key: string): string | undefined {
  return ENV_LABELS[key] ?? ENV_LABELS[key.toUpperCase()]
}

export type ConfigLabel = { title: string; key: string; desc?: string; mono: boolean }

// env 下的变量名：登记过的显示“中文名 + 等宽键名”，没登记的原样等宽；run 名字是用户自己起的，原样显示
export function configLabel(path: string[]): ConfigLabel {
  const key = path[path.length - 1] ?? ""
  const parent = path[path.length - 2]
  if (parent === "env") {
    const title = envLabel(key)
    return title ? { title, key, mono: false } : { title: key, key, mono: true }
  }
  if (path[0] === "runs" && path.length === 2) {
    return { title: key, key, mono: true }
  }
  const hit = LABELS[key]
  return hit ? { title: hit.title, key, desc: hit.desc, mono: false } : { title: key, key, mono: true }
}
