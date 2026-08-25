// TS 版本，与 lib/json5-text-edit.js 保持算法一致：在 JSON5 文本里按路径定位某个
// 属性值的字符范围，用于只替换该值本身，不影响文件其余部分的注释/格式。
// 系统设置分类表单靠这个实现"改一个字段就只动一小段文本"，从而不破坏 manyoyo.json 里的注释。

export type TextRange = { start: number; end: number }
export type TextReplacement = { start: number; end: number; text: string }

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch)
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function skipTrivia(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length) {
    const ch = text[cursor]
    const next = text[cursor + 1]
    if (/\s/.test(ch)) {
      cursor += 1
      continue
    }
    if (ch === "/" && next === "/") {
      cursor += 2
      while (cursor < text.length && text[cursor] !== "\n") {
        cursor += 1
      }
      continue
    }
    if (ch === "/" && next === "*") {
      cursor += 2
      while (cursor + 1 < text.length && !(text[cursor] === "*" && text[cursor + 1] === "/")) {
        cursor += 1
      }
      cursor = cursor + 1 < text.length ? cursor + 2 : text.length
      continue
    }
    break
  }
  return cursor
}

function scanValueEnd(text: string, startIndex: number): number {
  let cursor = startIndex
  let stringQuote = ""
  let lineComment = false
  let blockComment = false
  let depth = 0

  for (; cursor < text.length; cursor += 1) {
    const ch = text[cursor]
    const next = text[cursor + 1]

    if (lineComment) {
      if (ch === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false
        cursor += 1
      }
      continue
    }
    if (stringQuote) {
      if (ch === "\\") {
        cursor += 1
        continue
      }
      if (ch === stringQuote) stringQuote = ""
      continue
    }

    if (ch === "/" && next === "/") {
      lineComment = true
      cursor += 1
      continue
    }
    if (ch === "/" && next === "*") {
      blockComment = true
      cursor += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch
      continue
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1
      continue
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break
      depth -= 1
      continue
    }
    if (depth === 0 && ch === ",") break
  }

  let end = cursor
  while (end > startIndex && /\s/.test(text[end - 1])) {
    end -= 1
  }
  return end
}

function findRootObjectStart(text: string): number {
  const start = skipTrivia(text, 0)
  return text[start] === "{" ? start : -1
}

function readQuotedString(text: string, startIndex: number): { value: string; end: number } | null {
  const quote = text[startIndex]
  let value = ""
  for (let i = startIndex + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "\\") {
      value += ch
      if (i + 1 < text.length) {
        value += text[i + 1]
        i += 1
      }
      continue
    }
    if (ch === quote) {
      return { value, end: i + 1 }
    }
    value += ch
  }
  return null
}

function readPropertyToken(text: string, startIndex: number): { value: string; end: number } | null {
  const ch = text[startIndex]
  if (ch === '"' || ch === "'") {
    return readQuotedString(text, startIndex)
  }
  if (!isIdentifierStart(ch)) {
    return null
  }
  let end = startIndex + 1
  while (end < text.length && isIdentifierPart(text[end])) {
    end += 1
  }
  return { value: text.slice(startIndex, end), end }
}

function findObjectPropertyValueRange(
  text: string,
  objectStartIndex: number,
  propertyName: string
): TextRange | null {
  let cursor = skipTrivia(text, objectStartIndex + 1)
  while (cursor < text.length) {
    cursor = skipTrivia(text, cursor)
    if (text[cursor] === "}") {
      return null
    }
    const token = readPropertyToken(text, cursor)
    if (!token) {
      return null
    }
    cursor = skipTrivia(text, token.end)
    if (text[cursor] !== ":") {
      return null
    }
    const valueStart = skipTrivia(text, cursor + 1)
    const valueEnd = scanValueEnd(text, valueStart)
    if (token.value === propertyName) {
      return { start: valueStart, end: valueEnd }
    }
    cursor = skipTrivia(text, valueEnd)
    if (text[cursor] === ",") {
      cursor += 1
      continue
    }
    if (text[cursor] === "}") {
      return null
    }
  }
  return null
}

export function findValueRangeByPath(text: string, pathParts: string[]): TextRange | null {
  if (!Array.isArray(pathParts) || pathParts.length === 0) {
    return null
  }

  let objectStart = findRootObjectStart(text)
  if (objectStart === -1) {
    return null
  }

  let range: TextRange | null = null
  for (let i = 0; i < pathParts.length; i += 1) {
    range = findObjectPropertyValueRange(text, objectStart, pathParts[i])
    if (!range) {
      return null
    }
    if (i === pathParts.length - 1) {
      return range
    }
    const nextObjectStart = skipTrivia(text, range.start)
    if (text[nextObjectStart] !== "{") {
      return null
    }
    objectStart = nextObjectStart
  }
  return range
}

export function applyTextReplacements(text: string, replacements: TextReplacement[]): string {
  return replacements
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, item) => `${result.slice(0, item.start)}${item.text}${result.slice(item.end)}`, text)
}
