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
      link: '/zh/',
      themeConfig: {
        siteTitle: 'MANYOYO 文档',
        nav: [
          { text: '首页', link: '/zh/' },
          { text: '快速开始', link: '/zh/guide/quick-start' },
          {
            text: '文档',
            items: [
              { text: '指南', link: '/zh/guide/installation' },
              { text: '配置', link: '/zh/configuration/' },
              { text: '参考', link: '/zh/reference/cli-options' },
              { text: '高级', link: '/zh/advanced/docker-in-docker' },
              { text: '故障排查', link: '/zh/troubleshooting/' }
            ]
          },
          { text: 'English', link: '/en/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '基础指南',
              collapsed: false,
              items: [
                { text: '快速开始', link: '/zh/guide/quick-start' },
                { text: '安装详解', link: '/zh/guide/installation' },
                { text: '基础用法', link: '/zh/guide/basic-usage' }
              ]
            }
          ],
          '/zh/configuration/': [
            {
              text: '配置系统',
              collapsed: false,
              items: [
                { text: '配置概览', link: '/zh/configuration/' },
                { text: '环境变量', link: '/zh/configuration/environment' },
                { text: '配置文件', link: '/zh/configuration/config-files' },
                { text: '配置示例', link: '/zh/configuration/examples' }
              ]
            }
          ],
          '/zh/reference/': [
            {
              text: '命令参考',
              collapsed: false,
              items: [
                { text: '命令行选项', link: '/zh/reference/cli-options' },
                { text: 'AI 智能体', link: '/zh/reference/agents' },
                { text: '容器模式', link: '/zh/reference/container-modes' }
              ]
            }
          ],
          '/zh/advanced/': [
            {
              text: '高级主题',
              collapsed: false,
              items: [
                { text: 'Docker-in-Docker', link: '/zh/advanced/docker-in-docker' },
                { text: '会话管理', link: '/zh/advanced/session-management' }
              ]
            }
          ],
          '/zh/troubleshooting/': [
            {
              text: '故障排查',
              collapsed: false,
              items: [
                { text: '问题索引', link: '/zh/troubleshooting/' },
                { text: '构建问题', link: '/zh/troubleshooting/build-errors' },
                { text: '运行时问题', link: '/zh/troubleshooting/runtime-errors' }
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
          { text: 'Quick Start', link: '/en/guide/quick-start' },
          {
            text: 'Documentation',
            items: [
              { text: 'Guide', link: '/en/guide/installation' },
              { text: 'Configuration', link: '/en/configuration/' },
              { text: 'Reference', link: '/en/reference/cli-options' },
              { text: 'Advanced', link: '/en/advanced/docker-in-docker' },
              { text: 'Troubleshooting', link: '/en/troubleshooting/' }
            ]
          },
          { text: '中文', link: '/zh/' },
          { text: 'GitHub', link: repo }
        ],
        sidebar: {
          '/en/guide/': [
            {
              text: 'Basic Guide',
              collapsed: false,
              items: [
                { text: 'Quick Start', link: '/en/guide/quick-start' },
                { text: 'Installation', link: '/en/guide/installation' },
                { text: 'Basic Usage', link: '/en/guide/basic-usage' }
              ]
            }
          ],
          '/en/configuration/': [
            {
              text: 'Configuration System',
              collapsed: false,
              items: [
                { text: 'Overview', link: '/en/configuration/' },
                { text: 'Environment Variables', link: '/en/configuration/environment' },
                { text: 'Configuration Files', link: '/en/configuration/config-files' },
                { text: 'Examples', link: '/en/configuration/examples' }
              ]
            }
          ],
          '/en/reference/': [
            {
              text: 'Command Reference',
              collapsed: false,
              items: [
                { text: 'CLI Options', link: '/en/reference/cli-options' },
                { text: 'AI Agents', link: '/en/reference/agents' },
                { text: 'Container Modes', link: '/en/reference/container-modes' }
              ]
            }
          ],
          '/en/advanced/': [
            {
              text: 'Advanced Topics',
              collapsed: false,
              items: [
                { text: 'Docker-in-Docker', link: '/en/advanced/docker-in-docker' },
                { text: 'Session Management', link: '/en/advanced/session-management' }
              ]
            }
          ],
          '/en/troubleshooting/': [
            {
              text: 'Troubleshooting',
              collapsed: false,
              items: [
                { text: 'Issue Index', link: '/en/troubleshooting/' },
                { text: 'Build Errors', link: '/en/troubleshooting/build-errors' },
                { text: 'Runtime Errors', link: '/en/troubleshooting/runtime-errors' }
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
