import redirectData from './redirects.json' with { type: 'json' }

// 旧地址 → 新地址（都是以 / 开头的站内路由）。仓库里不放任何跳转页文件，构建结束时按这张表生成静态 HTML：
// 1. 中文原来在 /zh/ 下：每个中文页面的 /zh/<路径> → /<路径>
// 2. 页面移动过：旧位置的根、/zh/、/en/ 三种旧地址 → 新位置（moved 表见 redirects.json，check-docs-seo.js 也读它）
export function buildRedirects(pageRoutes: string[]): Map<string, string> {
  const real = new Set(pageRoutes)
  const redirects = new Map<string, string>()
  const add = (from: string, to: string) => {
    if (!real.has(from) && real.has(to)) redirects.set(from, to)
  }

  for (const route of pageRoutes) {
    if (route === '/en/' || route.startsWith('/en/')) continue
    add(route === '/' ? '/zh/' : `/zh${route}`, route)
  }

  for (const [from, to] of Object.entries(redirectData.moved)) {
    add(`/${from}`, `/${to}`)
    add(`/zh/${from}`, `/${to}`)
    add(`/en/${from}`, `/en/${to}`)
  }
  return redirects
}

// 旧路由对应的输出文件（cleanUrls：/a/b → a/b.html，/a/ → a/index.html）
export function redirectFile(route: string): string {
  return route.endsWith('/') ? `${route.slice(1)}index.html` : `${route.slice(1)}.html`
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderRedirectHtml(options: { lang: string; href: string; canonical: string }): string {
  const lang = options.lang
  const href = escapeAttr(options.href)
  const canonical = escapeAttr(options.canonical)
  const text = lang === 'en' ? 'This page has moved to' : '此页面已移动到'
  const title = lang === 'en' ? 'Page moved | MANYOYO' : '页面已移动 | MANYOYO'
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${canonical}">
<meta http-equiv="refresh" content="0; url=${href}">
</head>
<body>
<p>${text} <a href="${href}">${href}</a></p>
</body>
</html>
`
}
