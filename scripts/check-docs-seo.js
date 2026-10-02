#!/usr/bin/env node
'use strict';

// 文档站构建产物的 SEO 检查（npm run docs:build 之后运行）：
//   - 不含 JS 跳转（location.replace）；首页不含 noindex；sitemap.xml 不含 /zh/；
//   - 每个真实页面都有自己的 description（不是站点默认值）；
//   - 旧地址（/zh/<路径> 与移动过的页面，见 docs/.vitepress/redirects.json）都生成了静态 meta refresh 页，且目标存在。
// 用法: node scripts/check-docs-seo.js [dist 目录]

const fs = require('fs');
const path = require('path');

const DEFAULT_DESCRIPTION = 'AI Agent CLI Security Sandbox';
const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}

function checkDocsSeo(distDir, redirectsFile = path.join(ROOT, 'docs', '.vitepress', 'redirects.json')) {
    const problemSet = new Set();
    const problems = { push: message => problemSet.add(message) };
    if (!fs.existsSync(distDir)) return [`找不到构建产物目录: ${distDir}（先运行 npm run docs:build）`];
    const rel = file => path.relative(distDir, file).split(path.sep).join('/');
    const files = walk(distDir);
    const isRedirect = text => /http-equiv="refresh"/i.test(text);
    const pages = [];
    const redirectTargets = [];

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        if (/location\.replace/.test(text)) problems.push(`${rel(file)}: 含 location.replace（JS 跳转）`);
        if (isRedirect(text)) {
            const target = (text.match(/http-equiv="refresh" content="0; url=([^"]+)"/i) || [])[1];
            if (!target) problems.push(`${rel(file)}: meta refresh 缺少目标`);
            else redirectTargets.push({ file: rel(file), target });
            if (!/<meta name="robots" content="noindex">/.test(text)) problems.push(`${rel(file)}: 跳转页缺少 noindex`);
            if (!/<link rel="canonical" href="[^"]+">/.test(text)) problems.push(`${rel(file)}: 跳转页缺少 canonical`);
            continue;
        }
        if (!/id="app"/.test(text) || rel(file) === '404.html') continue; // 404 页与站点验证文件不检查
        pages.push({ file, text, route: rel(file) });
    }

    const home = path.join(distDir, 'index.html');
    if (!fs.existsSync(home)) problems.push('缺少首页 index.html');
    else if (/<meta name="robots" content="noindex/.test(fs.readFileSync(home, 'utf8'))) problems.push('index.html 含 noindex');

    const sitemap = path.join(distDir, 'sitemap.xml');
    if (!fs.existsSync(sitemap)) problems.push('缺少 sitemap.xml');
    else if (/\/zh\//.test(fs.readFileSync(sitemap, 'utf8'))) problems.push('sitemap.xml 含 /zh/');

    for (const page of pages) {
        const description = (page.text.match(/<meta name="description" content="([^"]*)"/) || [])[1];
        if (!description || description === DEFAULT_DESCRIPTION) problems.push(`${page.route}: description 缺失或是站点默认值`);
        if (/<meta name="robots" content="noindex/.test(page.text)) problems.push(`${page.route}: 真实页面不应是 noindex`);
        const canonicals = page.text.match(/<link rel="canonical" href="[^"]+"/g) || [];
        if (canonicals.length !== 1) problems.push(`${page.route}: 应有且只有一个 canonical（现有 ${canonicals.length} 个）`);
    }

    // 期望存在的旧地址跳转页
    const expected = [];
    const real = new Set(pages.map(page => page.route));
    for (const page of pages) {
        if (page.route.startsWith('en/')) continue;
        expected.push(`zh/${page.route}`);
    }
    const moved = JSON.parse(fs.readFileSync(redirectsFile, 'utf8')).moved || {};
    for (const [from, to] of Object.entries(moved)) {
        for (const [prefix, targetPrefix] of [['', ''], ['zh/', ''], ['en/', 'en/']]) {
            if (!real.has(`${prefix}${from}.html`)) expected.push(`${prefix}${from}.html`);
            if (!real.has(`${targetPrefix}${to}.html`)) problems.push(`移动表的目标页不存在: ${targetPrefix}${to}`);
        }
    }
    for (const file of expected) {
        const full = path.join(distDir, file);
        if (!fs.existsSync(full)) problems.push(`缺少旧地址跳转页: ${file}`);
        else if (!isRedirect(fs.readFileSync(full, 'utf8'))) problems.push(`${file}: 应是跳转页`);
    }
    // 每个跳转页的目标都必须是真实页面（目标可能带部署前缀 /manyoyo）
    for (const { file, target } of redirectTargets) {
        const route = target.replace(/^\/manyoyo(?=\/)/, '');
        const targetFile = route.endsWith('/') ? `${route.slice(1)}index.html` : `${route.slice(1)}.html`;
        if (!real.has(targetFile)) problems.push(`${file}: 跳转目标不是真实页面: ${target}`);
    }
    return [...problemSet];
}

if (require.main === module) {
    const distDir = path.resolve(process.argv[2] || path.join(ROOT, 'docs', '.vitepress', 'dist'));
    const problems = checkDocsSeo(distDir);
    if (problems.length > 0) {
        console.error(`文档站 SEO 检查未通过（${problems.length} 项）:`);
        problems.forEach(problem => console.error(`  - ${problem}`));
        process.exit(1);
    }
    console.log('文档站 SEO 检查通过');
}

module.exports = { checkDocsSeo };
