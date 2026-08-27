import { describe, expect, test } from "vitest"

import { markdownContentPropsEqual } from "./markdown-content"

// 回归用例：轮询同步（ActivityView 每 6s/1.5s 拉一次最新消息）会让 messages 数组
// 整体换成新对象，调用方在 map 里内联传给 MarkdownContent 的 onPreviewHtml 因此
// 每次都是新函数引用。若 React.memo 的比较函数把这个引用也纳入比较，会导致
// content 完全没变时依旧判定为"props 变了"，进而重新设置 dangerouslySetInnerHTML，
// 把代码块内部已有的横向滚动位置/文字选区悄悄清零（移动端表现为横滑查看代码块
// 时滚动条突然复位）。
describe("markdownContentPropsEqual", () => {
  test("content 不变时，onPreviewHtml 引用变化不应视为 props 变化", () => {
    const a = { content: "```js\nconst a = 1;\n```", onPreviewHtml: () => {} }
    const b = { content: "```js\nconst a = 1;\n```", onPreviewHtml: () => {} }
    expect(markdownContentPropsEqual(a, b)).toBe(true)
  })

  test("content 变化时应视为 props 变化", () => {
    const a = { content: "旧内容" }
    const b = { content: "新内容" }
    expect(markdownContentPropsEqual(a, b)).toBe(false)
  })

  test("onPreviewHtml 从有到无（是否支持预览发生变化）应视为 props 变化", () => {
    const a = { content: "同样的内容", onPreviewHtml: () => {} }
    const b = { content: "同样的内容" }
    expect(markdownContentPropsEqual(a, b)).toBe(false)
  })

  test("className 变化时应视为 props 变化", () => {
    const a = { content: "同样的内容", className: "a" }
    const b = { content: "同样的内容", className: "b" }
    expect(markdownContentPropsEqual(a, b)).toBe(false)
  })
})
