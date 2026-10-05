import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitepress'
import { buildRedirects, redirectFile, renderRedirectHtml } from './redirects.mts'

const repo = 'https://github.com/xcanwin/manyoyo'
const editBase = 'https://github.com/xcanwin/manyoyo/edit/main/docs'
const siteUrl = 'https://xcanwin.github.io/manyoyo/'
const sitePathPrefix = new URL(siteUrl).pathname.replace(/\/$/, '')
const siteName = 'MANYOYO'
const defaultDescription = 'AI Agent CLI Security Sandbox'
const defaultKeywords = [
  'manyoyo',
  'ai agent sandbox',
  'ai agent cli',
  'claude code',
  'codex cli',
  'gemini cli',
  'docker sandbox',
  'podman sandbox',
  'yolo mode'
].join(', ')
const defaultOgImage = `${siteUrl}images/manyoyo-og-cover.svg`
const readmeRewrites = {
  'README.md': 'index.md',
  'configuration/README.md': 'configuration/index.md',
  'troubleshooting/README.md': 'troubleshooting/index.md',
  'en/README.md': 'en/index.md',
  'en/configuration/README.md': 'en/configuration/index.md',
  'en/troubleshooting/README.md': 'en/troubleshooting/index.md'
}

function toRoutePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/\.md$/, '')

  if (normalized === 'index' || normalized === 'README') {
    return '/'
  }

  if (normalized.endsWith('/index') || normalized.endsWith('/README')) {
    const suffix = normalized.endsWith('/index') ? '/index' : '/README'
    return `/${normalized.slice(0, -suffix.length)}/`
  }

  return `/${normalized}`
}

function toAbsoluteUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), siteUrl).toString()
}

function toRoutePathFromUrl(url: string): string {
  const parsed = new URL(url, siteUrl)
  let routePath = parsed.pathname

  if (sitePathPrefix && (routePath === sitePathPrefix || routePath.startsWith(`${sitePathPrefix}/`))) {
    routePath = routePath.slice(sitePathPrefix.length) || '/'
  }

  if (!routePath.startsWith('/')) {
    routePath = `/${routePath}`
  }

  return routePath
}

// 中文在根路径，英文在 /en/ 下，两边同构
function resolveLocalePaths(routePath: string): { zhPath: string; enPath: string } {
  if (routePath === '/en/' || routePath.startsWith('/en/')) {
    return { zhPath: routePath.replace(/^\/en/, '') || '/', enPath: routePath }
  }
  return { zhPath: routePath, enPath: routePath === '/' ? '/en/' : `/en${routePath}` }
}

export default defineConfig({
  title: siteName,
  description: defaultDescription,
  base: process.env.GITHUB_ACTIONS ? '/manyoyo/' : '/',
  cleanUrls: true,
  rewrites: readmeRewrites,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#0f766e' }],
    ['meta', { name: 'keywords', content: defaultKeywords }]
  ],
  sitemap: {
    hostname: siteUrl,
    transformItems: (items) => {
      return items.map((item) => {
        const { zhPath, enPath } = resolveLocalePaths(toRoutePathFromUrl(item.url))
        return {
          ...item,
          links: [
            { lang: 'zh-CN', url: toAbsoluteUrl(zhPath) },
            { lang: 'en', url: toAbsoluteUrl(enPath) },
            { lang: 'x-default', url: toAbsoluteUrl('/') }
          ]
        }
      })
    }
  },
  // 旧地址（/zh/** 与移动过的页面）：构建结束时生成纯静态的 meta refresh 页，不依赖 JS（GitHub Pages 做不了 301）
  buildEnd: async (siteConfig) => {
    const routes = siteConfig.pages.map((page) => toRoutePath(page))
    const base = siteConfig.site.base.replace(/\/$/, '')
    for (const [from, to] of buildRedirects(routes)) {
      const file = path.join(siteConfig.outDir, redirectFile(from))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, renderRedirectHtml({
        lang: to.startsWith('/en/') ? 'en' : 'zh-CN',
        href: `${base}${to}`,
        canonical: toAbsoluteUrl(to)
      }))
    }
  },
  transformHead: ({ pageData, description }) => {
    const routePath = toRoutePath(pageData.relativePath)
    const { zhPath, enPath } = resolveLocalePaths(routePath)
    const canonicalUrl = toAbsoluteUrl(routePath)
    const pageTitle =
      (typeof pageData.frontmatter.title === 'string' && pageData.frontmatter.title) ||
      pageData.title ||
      siteName
    const pageDescription = description || defaultDescription
    const locale = routePath.startsWith('/en/') ? 'en_US' : 'zh_CN'
    const alternateLocale = locale === 'en_US' ? 'zh_CN' : 'en_US'
    const head = [
      ['link', { rel: 'canonical', href: canonicalUrl }],
      ['link', { rel: 'alternate', hreflang: 'zh-CN', href: toAbsoluteUrl(zhPath) }],
      ['link', { rel: 'alternate', hreflang: 'en', href: toAbsoluteUrl(enPath) }],
      ['link', { rel: 'alternate', hreflang: 'x-default', href: toAbsoluteUrl('/') }],
      ['meta', { name: 'robots', content: 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: siteName }],
      ['meta', { property: 'og:title', content: pageTitle }],
      ['meta', { property: 'og:description', content: pageDescription }],
      ['meta', { property: 'og:url', content: canonicalUrl }],
      ['meta', { property: 'og:image', content: defaultOgImage }],
      ['meta', { property: 'og:locale', content: locale }],
      ['meta', { property: 'og:locale:alternate', content: alternateLocale }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: pageTitle }],
      ['meta', { name: 'twitter:description', content: pageDescription }],
      ['meta', { name: 'twitter:image', content: defaultOgImage }]
    ] as [string, Record<string, string>, string?][]

    if (routePath === '/' || routePath === '/en/') {
      const inLanguage = routePath.startsWith('/en/') ? 'en-US' : 'zh-CN'
      const siteDescription = routePath.startsWith('/en/')
        ? 'Security sandbox for running AI Agent CLI tools with Docker or Podman.'
        : '用于在 Docker 或 Podman 中安全运行 AI Agent CLI 工具的安全沙箱。'
      const jsonLd = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: siteName,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows',
        inLanguage,
        description: siteDescription,
        url: siteUrl,
        codeRepository: repo,
        license: `${repo}/blob/main/LICENSE`
      })
      head.push(['script', { type: 'application/ld+json' }, jsonLd])
    }

    return head
  },

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/',
      themeConfig: {
        siteTitle: 'MANYOYO 文档',
        nav: [
          { text: '安装', link: '/guide/quick-start' },
          {
            text: '文档',
            items: [
              { text: '开始使用', link: '/guide/introduction' },
              { text: '使用指南', link: '/guide/basic-usage' },
              { text: '配置', link: '/configuration/' },
              { text: '参考', link: '/reference/cli-options' },
              { text: '进阶与开发', link: '/advanced/installation' }
            ]
          },
          { text: '常见问题', link: '/troubleshooting/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/': [
            {
              text: '开始使用',
              collapsed: false,
              items: [
                { text: '介绍', link: '/guide/introduction' },
                { text: '安装', link: '/guide/quick-start' },
                { text: '第一次使用', link: '/guide/first-run' },
                { text: '日常使用', link: '/guide/daily' }
              ]
            },
            {
              text: '使用指南',
              collapsed: false,
              items: [
                { text: '命令行运行 Agent', link: '/guide/basic-usage' },
                { text: '迁移已有 Agent 配置', link: '/guide/migrate' },
                { text: '网页服务与远程访问', link: '/guide/web' },
                { text: '管理容器的 env、网络与自启动', link: '/guide/container-manage' },
                { text: '安全须知', link: '/guide/security' }
              ]
            },
            {
              text: '配置',
              collapsed: true,
              items: [
                { text: '配置入门', link: '/configuration/' },
                { text: '配置项参考', link: '/configuration/config-files' },
                { text: '环境变量', link: '/configuration/environment' },
                { text: '配置示例', link: '/configuration/examples' }
              ]
            },
            {
              text: '参考',
              collapsed: true,
              items: [
                { text: '命令速查', link: '/reference/cli-options' },
                { text: '支持的 Agent', link: '/reference/agents' },
                { text: '容器模式', link: '/reference/container-modes' }
              ]
            },
            {
              text: '常见问题',
              collapsed: true,
              items: [
                { text: '常见问题', link: '/troubleshooting/' },
                { text: '运行时问题', link: '/troubleshooting/runtime-errors' }
              ]
            },
            {
              text: '进阶与开发',
              collapsed: true,
              items: [
                { text: '安装详解', link: '/advanced/installation' },
                { text: '自定义镜像', link: '/advanced/custom-image' },
                { text: '镜像构建问题', link: '/advanced/build-errors' },
                { text: 'Docker-in-Docker', link: '/advanced/docker-in-docker' },
                { text: '会话管理与恢复', link: '/advanced/session-management' },
                { text: 'Playwright 插件', link: '/advanced/playwright' },
                { text: '参与开发', link: '/advanced/contributing' }
              ]
            }
          ]
        },
        socialLinks: [{ icon: 'github', link: repo }],
        search: { provider: 'local' },
        editLink: {
          pattern: `${editBase}/:path`,
          text: '在 GitHub 上编辑此页'
        },
        lastUpdated: { text: '最后更新于' },
        returnToTopLabel: '返回顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        outline: { level: [2, 3], label: '页面导航' },
        docFooter: { prev: '上一页', next: '下一页' },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © 2026 xcanwin'
        }
      }
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        siteTitle: 'MANYOYO Docs',
        nav: [
          { text: 'Install', link: '/en/guide/quick-start' },
          {
            text: 'Documentation',
            items: [
              { text: 'Getting Started', link: '/en/guide/introduction' },
              { text: 'Guides', link: '/en/guide/basic-usage' },
              { text: 'Configuration', link: '/en/configuration/' },
              { text: 'Reference', link: '/en/reference/cli-options' },
              { text: 'Advanced & Development', link: '/en/advanced/installation' }
            ]
          },
          { text: 'FAQ', link: '/en/troubleshooting/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/en/': [
            {
              text: 'Getting Started',
              collapsed: false,
              items: [
                { text: 'Introduction', link: '/en/guide/introduction' },
                { text: 'Install', link: '/en/guide/quick-start' },
                { text: 'First Run', link: '/en/guide/first-run' },
                { text: 'Daily Use', link: '/en/guide/daily' }
              ]
            },
            {
              text: 'Guides',
              collapsed: false,
              items: [
                { text: 'Run Agents from the CLI', link: '/en/guide/basic-usage' },
                { text: 'Migrate Existing Agent Configs', link: '/en/guide/migrate' },
                { text: 'Web Service and Remote Access', link: '/en/guide/web' },
                { text: 'Manage env, network and autostart', link: '/en/guide/container-manage' },
                { text: 'Security Notes', link: '/en/guide/security' }
              ]
            },
            {
              text: 'Configuration',
              collapsed: true,
              items: [
                { text: 'Configuration Basics', link: '/en/configuration/' },
                { text: 'Configuration Reference', link: '/en/configuration/config-files' },
                { text: 'Environment Variables', link: '/en/configuration/environment' },
                { text: 'Examples', link: '/en/configuration/examples' }
              ]
            },
            {
              text: 'Reference',
              collapsed: true,
              items: [
                { text: 'Command Cheat Sheet', link: '/en/reference/cli-options' },
                { text: 'Supported Agents', link: '/en/reference/agents' },
                { text: 'Container Modes', link: '/en/reference/container-modes' }
              ]
            },
            {
              text: 'FAQ',
              collapsed: true,
              items: [
                { text: 'FAQ', link: '/en/troubleshooting/' },
                { text: 'Runtime Issues', link: '/en/troubleshooting/runtime-errors' }
              ]
            },
            {
              text: 'Advanced & Development',
              collapsed: true,
              items: [
                { text: 'Installation Details', link: '/en/advanced/installation' },
                { text: 'Custom Image', link: '/en/advanced/custom-image' },
                { text: 'Image Build Issues', link: '/en/advanced/build-errors' },
                { text: 'Docker-in-Docker', link: '/en/advanced/docker-in-docker' },
                { text: 'Session Management and Recovery', link: '/en/advanced/session-management' },
                { text: 'Playwright Plugin', link: '/en/advanced/playwright' },
                { text: 'Contributing', link: '/en/advanced/contributing' }
              ]
            }
          ]
        },
        socialLinks: [{ icon: 'github', link: repo }],
        search: { provider: 'local' },
        editLink: {
          pattern: `${editBase}/:path`,
          text: 'Edit this page on GitHub'
        },
        lastUpdated: { text: 'Last updated' },
        outline: { level: [2, 3], label: 'On this page' },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © 2026 xcanwin'
        }
      }
    }
  }
})
