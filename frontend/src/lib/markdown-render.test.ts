import { describe, expect, test } from "vitest"

import { renderMarkdownToHtml } from "./markdown-render"

// 覆盖 markdown 渲染的安全行为（链接安全属性、外链图片
// 降级、XSS 防护），具体实现方式不同（shadcn 用 DOMPurify + React Dialog 二次确认，
// 而不是手写转义 + window.confirm），用例按实际输出书写
describe("renderMarkdownToHtml", () => {
  test("链接带上 noopener/noreferrer 与 no-referrer，防止 Referer 泄露", () => {
    const { html } = renderMarkdownToHtml("[OpenAI](https://openai.com)", false)
    expect(html).toContain('href="https://openai.com"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain(">OpenAI</a>")
  })

  test("相对路径图片按普通 img 渲染", () => {
    const { html } = renderMarkdownToHtml("![diagram](./diagram.png)", false)
    expect(html).toContain('<img src="./diagram.png"')
  })

  // 回归用例：DOMPurify 的 ALLOWED_URI_REGEXP 曾经收窄成只认 "/" 开头的 URI，
  // 导致不带开头斜杠的相对路径（容器内 markdown 文件里最常见的写法）的 src
  // 被整个过滤掉，图片直接不显示且没有任何报错提示
  test("不带开头斜杠的相对路径图片（容器内 markdown 文件常见写法）src 不被过滤", () => {
    const { html } = renderMarkdownToHtml("![diagram](diagram.png)", false)
    expect(html).toContain('<img src="diagram.png"')
    const { html: nestedHtml } = renderMarkdownToHtml("![diagram](images/diagram.png)", false)
    expect(nestedHtml).toContain('<img src="images/diagram.png"')
  })

  test("外部 http(s) 图片降级为点击确认链接，不直接渲染 img（防跟踪像素/IP 泄露）", () => {
    const { html } = renderMarkdownToHtml("![diagram](https://example.com/diagram.png)", false)
    expect(html).not.toContain("<img")
    expect(html).toContain('href="https://example.com/diagram.png"')
    expect(html).toContain("点击查看图片")
  })

  test("原始 HTML 标签被 DOMPurify 过滤，script 标签不会进入输出", () => {
    const { html } = renderMarkdownToHtml('<img src=x onerror="alert(1)">', false)
    expect(html).not.toContain("onerror")
    const { html: scriptHtml } = renderMarkdownToHtml("<script>alert(1)</script>", false)
    expect(scriptHtml).not.toContain("<script")
  })

  test("危险协议（javascript:）链接被 DOMPurify 拦截", () => {
    const { html } = renderMarkdownToHtml("[点我](javascript:alert(1))", false)
    expect(html).not.toContain("javascript:")
  })

  test("enableHtmlPreview=false 时不注入预览按钮，htmlBlocks 为空", () => {
    const { html, htmlBlocks } = renderMarkdownToHtml("```html\n<b>hi</b>\n```", false)
    expect(html).not.toContain("data-preview-html-index")
    expect(htmlBlocks).toEqual([])
  })

  test("enableHtmlPreview=true 时给 html 代码块注入预览按钮并收集原文", () => {
    const { html, htmlBlocks } = renderMarkdownToHtml("```html\n<b>hi</b>\n```", true)
    expect(html).toContain('data-preview-html-index="0"')
    expect(htmlBlocks).toEqual(["<b>hi</b>"])
  })

  test("非 html 代码块即使开启预览也不注入按钮", () => {
    const { html, htmlBlocks } = renderMarkdownToHtml("```js\nconsole.log(1)\n```", true)
    expect(html).not.toContain("data-preview-html-index")
    expect(htmlBlocks).toEqual([])
  })
})

describe("裸网址不自动成链接", () => {
  test("纯文本网址（含紧跟的括号）保持纯文本", () => {
    const { html } = renderMarkdownToHtml("https://www.baidu.com(baidu)", false)
    expect(html).not.toContain("<a")
    expect(html).toContain("https://www.baidu.com(baidu)")
  })

  test("显式 markdown 链接与尖括号链接仍渲染成链接", () => {
    expect(renderMarkdownToHtml("[百度](https://www.baidu.com)", false).html).toContain('href="https://www.baidu.com"')
    expect(renderMarkdownToHtml("<https://www.baidu.com>", false).html).toContain('href="https://www.baidu.com"')
  })
})

describe("代码块复制按钮", () => {
  test("围栏代码块带复制按钮，原文按下标放进 codeBlocks", () => {
    const { html, codeBlocks } = renderMarkdownToHtml("```js\nconst a = 1\n```", false)
    expect(html).toContain('data-copy-code-index="0"')
    expect(codeBlocks).toEqual(["const a = 1"])
  })

  test("html 代码块开启预览时多一个预览按钮，复制按钮仍在", () => {
    const { html, htmlBlocks, codeBlocks } = renderMarkdownToHtml("```html\n<b>x</b>\n```", true)
    expect(html).toContain('data-preview-html-index="0"')
    expect(html).toContain('data-copy-code-index="0"')
    expect(htmlBlocks).toEqual(["<b>x</b>"])
    expect(codeBlocks).toEqual(["<b>x</b>"])
  })
})

describe("表格单元格", () => {
  test("单元格内容包一层 md-cell，align 属性保留在 th/td 上", () => {
    const { html } = renderMarkdownToHtml("| a | b |\n| :---: | --- |\n| `x` | y |", false)
    expect(html).toContain('<th align="center"><div class="md-cell">a</div></th>')
    expect(html).toContain('<td align="center"><div class="md-cell"><code>x</code></div></td>')
    expect(html).toContain('<td><div class="md-cell">y</div></td>')
  })
})

describe("图片与路径（容器上下文）", () => {
  const ctx = { sessionName: "box~agent-1", baseDir: "/work/proj", pathLinks: true }
  const raw = (p: string) => `/api/sessions/${encodeURIComponent("box~agent-1")}/fs/raw?path=${encodeURIComponent(p)}`

  test("data URI 图片不渲染 img（markdown 写法）", () => {
    const { html } = renderMarkdownToHtml("![x](data:image/png;base64,iVBORw0KGgo=)", false)
    expect(html).not.toContain("<img")
    expect(html).not.toContain("data:image")
  })

  test("data URI 图片不渲染 img（原始 HTML 写法）", () => {
    const { html } = renderMarkdownToHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">', false)
    expect(html).not.toContain("<img")
  })

  test("原始 HTML 的外链图片也要点击确认，不自动加载", () => {
    const { html } = renderMarkdownToHtml('<img src="https://example.com/t.png" alt="t">', false)
    expect(html).not.toContain("<img")
    expect(html).toContain('href="https://example.com/t.png"')
    expect(html).toContain("点击查看图片")
  })

  test("容器内绝对路径图片改写成 fs/raw", () => {
    const { html } = renderMarkdownToHtml("![shot](/root/shot.png)", false, ctx)
    expect(html).toContain(`<img src="${raw("/root/shot.png").replace(/&/g, "&amp;")}"`)
  })

  test("相对路径图片按 baseDir 解析后改写", () => {
    const { html } = renderMarkdownToHtml("![d](./img/a.webp)", false, ctx)
    expect(html).toContain(raw("/work/proj/img/a.webp").replace(/&/g, "&amp;"))
  })

  test("原始 HTML 的容器内图片同样改写", () => {
    const { html } = renderMarkdownToHtml('<img src="/tmp/a.jpg">', false, ctx)
    expect(html).toContain(raw("/tmp/a.jpg").replace(/&/g, "&amp;"))
  })

  test("已经是站内 fs/raw 地址的保持不变", () => {
    const url = raw("/root/a.png")
    const { html } = renderMarkdownToHtml(`![a](${url})`, false, ctx)
    expect(html).toContain(`<img src="${url.replace(/&/g, "&amp;")}"`)
  })

  test("扩展名不在白名单的本地图片不渲染 img，改成可点开的路径", () => {
    const { html } = renderMarkdownToHtml("![s](/root/a.svg)", false, ctx)
    expect(html).not.toContain("<img")
    expect(html).toContain('data-open-path="/root/a.svg"')
  })

  test("整段是绝对路径的行内代码可点击打开", () => {
    const { html } = renderMarkdownToHtml("见 `/work/proj/src/a.ts` 和 `npm test`", false, ctx)
    expect(html).toContain('data-open-path="/work/proj/src/a.ts"')
    expect(html.match(/data-open-path/g)?.length).toBe(1)
  })

  test("以 / 开头的 markdown 链接可点击打开，/api/ 与 // 开头的不算", () => {
    const { html } = renderMarkdownToHtml("[a](/work/a.md) [b](/api/x) [c](//evil.com/x)", false, ctx)
    expect(html).toContain('data-open-path="/work/a.md"')
    expect(html).not.toContain('data-open-path="/api/x"')
    expect(html).not.toContain('data-open-path="//evil.com/x"')
  })

  test("行内代码里的相对路径按工作目录解析后可点击", () => {
    const rel = { ...ctx, baseDir: "/work/proj" }
    const html = renderMarkdownToHtml("`./a.txt` `a.txt` `./aaa/` `./././aaa` `src/b.ts` `../x.md` `aaa` `npm test` `console.log`", false, rel).html
    for (const p of ["/work/proj/a.txt", "/work/proj/aaa", "/work/proj/src/b.ts", "/work/x.md"]) {
      expect(html).toContain(`data-open-path="${p}"`)
    }
    expect(html.match(/data-open-path/g)?.length).toBe(6)
    expect(html).not.toContain('data-open-path="/work/proj/npm test"')
  })

  test("没开 pathLinks 时不生成可点击路径", () => {
    const { html } = renderMarkdownToHtml("`/work/a.ts`", false, { ...ctx, pathLinks: false })
    expect(html).not.toContain("data-open-path")
  })
})

describe("代码块高亮与语言标签", () => {
  test("支持的语言输出带 tok- 类名的 span，并显示语言标签", () => {
    const { html } = renderMarkdownToHtml("```ts\nconst a: number = 1 // x\n```", false)
    expect(html).toMatch(/<span class="tok-keyword">const<\/span>/)
    expect(html).toContain("tok-comment")
    expect(html).toContain('data-code-lang="ts"')
  })

  test("代码内容按文本转义，不会变成标签", () => {
    const { html, codeBlocks } = renderMarkdownToHtml('```html\n<img src=x onerror="alert(1)">\n```', false)
    expect(html).not.toMatch(/<img/)
    expect(html).toContain("&lt;")
    expect(codeBlocks[0]).toBe('<img src=x onerror="alert(1)">')
  })

  test("不支持的语言、超过上限的代码块不高亮，但仍显示语言标签", () => {
    const { html } = renderMarkdownToHtml("```rust\nfn main() {}\n```", false)
    expect(html).not.toContain("tok-")
    expect(html).toContain('data-code-lang="rust"')
    const big = "```js\n" + "const a = 1\n".repeat(3000) + "```"
    expect(renderMarkdownToHtml(big, false).html).not.toContain("tok-")
  })

  test("语言名里的奇怪字符不会进入属性", () => {
    const { html } = renderMarkdownToHtml('```js" onclick="x\nconst a = 1\n```', false)
    expect(html).not.toContain("onclick")
  })
})

test("一条消息里高亮总量有上限：超出后的代码块只标语言", () => {
  const block = "```js\n" + "const a = 1\n".repeat(1500) + "```\n"
  const { html } = renderMarkdownToHtml(Array.from({ length: 4 }, () => block).join("\n"), false)
  const highlightedBlocks = html.split("<pre>").slice(1).filter((part) => part.split("</pre>")[0].includes("tok-")).length
  expect(highlightedBlocks).toBeGreaterThan(0)
  expect(highlightedBlocks).toBeLessThan(4)
})

test("shell 代码块也高亮", () => {
  const { html } = renderMarkdownToHtml("```bash\necho \"hi\" # 注释\nnpm test\n```", false)
  expect(html).toContain("tok-string")
  expect(html).toContain("tok-comment")
})

test("高亮时整段字符串 token 里的标签也只当文本", () => {
  const { html } = renderMarkdownToHtml('```js\nconst s = "<img src=x onerror=alert(1)>"\n```', false)
  expect(html).toContain("tok-string")
  expect(html).not.toMatch(/<img/)
})

describe("审查回归", () => {
  test("链接里坏掉的 % 编码不会让渲染抛错", () => {
    expect(() => renderMarkdownToHtml('<a href="/tmp/%zz">x</a> `/tmp/%zz`', false, { sessionName: "s", baseDir: "/w", pathLinks: true })).not.toThrow()
  })
  test("没有会话上下文时，反斜杠、空白混进协议的外链图片也不会直接加载", () => {
    for (const src of ["/\\evil.com/x.png", "ht\ttps://evil.com/x.png", " //evil.com/x.png"]) {
      const { html } = renderMarkdownToHtml(`<img src="${src}">`, false)
      expect([src, html.includes("<img")]).toEqual([src, false])
    }
  })
})
