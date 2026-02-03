import { defineConfig } from 'vitepress'

const repo = 'https://github.com/xcanwin/manyoyo'
const editBase = 'https://github.com/xcanwin/manyoyo/edit/main/docs'

export default defineConfig({
  title: 'MANYOYO',
  description: 'AI Agent CLI Security Sandbox',
  base: process.env.GITHUB_ACTIONS ? '/manyoyo/' : '/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README_EN.md'],
  head: [['meta', { name: 'theme-color', content: '#0f766e' }]],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/',
      themeConfig: {
        siteTitle: 'MANYOYO 文档',
        nav: [
          { text: '首页', link: '/' },
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '命令参考', link: '/guide/command-reference' },
          { text: 'English', link: '/en/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/guide/': [
            {
              text: '使用指南',
              items: [
                { text: '快速开始', link: '/guide/getting-started' },
                { text: '命令参考', link: '/guide/command-reference' }
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
          { text: 'Home', link: '/en/' },
          { text: 'Getting Started', link: '/en/guide/getting-started' },
          { text: 'Command Reference', link: '/en/guide/command-reference' },
          { text: '中文', link: '/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/en/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Getting Started', link: '/en/guide/getting-started' },
                { text: 'Command Reference', link: '/en/guide/command-reference' }
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
