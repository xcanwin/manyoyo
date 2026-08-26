import { describe, expect, test } from "vitest"

import { renderMarkdownToHtml } from "./markdown-render"

// 对齐旧版前端 test/markdown-renderer.test.js 覆盖的行为（链接安全属性、外链图片
// 降级、XSS 防护），具体实现方式不同（shadcn 用 DOMPurify + React Dialog 二次确认，
// 不是旧版手写转义 + window.confirm），按 shadcn 实际输出改写用例
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
