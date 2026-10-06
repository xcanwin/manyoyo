'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkDocsSeo } = require('../scripts/check-docs-seo');

let dist;
let redirects;
beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-seo-'));
    redirects = path.join(dist, 'redirects.json');
    fs.writeFileSync(redirects, JSON.stringify({ moved: { 'guide/old': 'guide/new' } }));
});
afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

const page = (route, description = '页面说明', extra = '') => {
    const file = path.join(dist, route);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<html><head><meta name="description" content="${description}"><link rel="canonical" href="https://x/${route}">${extra}</head><body><div id="app"></div></body></html>`);
};
const redirect = (route, target = '/guide/new') => {
    const file = path.join(dist, route);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<html><head><meta name="robots" content="noindex"><link rel="canonical" href="https://x/"><meta http-equiv="refresh" content="0; url=' + target + '"></head></html>');
};

function healthySite() {
    page('index.html');
    page('guide/new.html');
    page('en/index.html');
    page('en/guide/new.html');
    redirect('zh/index.html');
    redirect('zh/guide/new.html');
    redirect('guide/old.html');
    redirect('zh/guide/old.html');
    redirect('en/guide/old.html', '/en/guide/new');
    fs.writeFileSync(path.join(dist, 'sitemap.xml'), '<urlset><loc>https://x/</loc></urlset>');
}

describe('check-docs-seo', () => {
    test('a healthy site passes', () => {
        healthySite();
        expect(checkDocsSeo(dist, redirects)).toEqual([]);
    });

    test('flags JS redirects, noindex on the home page and /zh/ in the sitemap', () => {
        healthySite();
        page('guide/new.html', '页面说明', '<script>window.location.replace("/x")</script>');
        page('index.html', '页面说明', '<meta name="robots" content="noindex">');
        fs.writeFileSync(path.join(dist, 'sitemap.xml'), '<loc>https://x/zh/guide/new</loc>');
        const problems = checkDocsSeo(dist, redirects).join('\n');
        expect(problems).toContain('location.replace');
        expect(problems).toContain('index.html 含 noindex');
        expect(problems).toContain('sitemap.xml 含 /zh/');
    });

    test('flags a page that falls back to the default description', () => {
        healthySite();
        page('guide/new.html', 'AI Agent CLI Security Sandbox');
        expect(checkDocsSeo(dist, redirects).join('\n')).toContain('guide/new.html: description');
    });

    test('flags a redirect whose target is not a real page', () => {
        healthySite();
        redirect('zh/guide/new.html', '/guide/nope');
        expect(checkDocsSeo(dist, redirects).join('\n')).toContain('跳转目标不是真实页面: /guide/nope');
        redirect('zh/guide/new.html', '/manyoyo/guide/new'); // 带部署前缀的目标也能识别
        expect(checkDocsSeo(dist, redirects)).toEqual([]);
    });

    test('flags missing redirect pages for /zh/ paths and moved pages', () => {
        healthySite();
        fs.rmSync(path.join(dist, 'zh/guide/new.html'));
        fs.rmSync(path.join(dist, 'en/guide/old.html'));
        const problems = checkDocsSeo(dist, redirects).join('\n');
        expect(problems).toContain('缺少旧地址跳转页: zh/guide/new.html');
        expect(problems).toContain('缺少旧地址跳转页: en/guide/old.html');
    });
});

describe('checkInstallScript', () => {
    const { checkInstallScript } = require('../scripts/check-docs-seo');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    test('产物缺少或与源文件不一致时报问题，一致时通过', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-install-'));
        const source = path.join(dir, 'source.sh');
        fs.writeFileSync(source, 'echo hi\n');
        try {
            expect(checkInstallScript(dir, source)).toHaveLength(1);
            fs.writeFileSync(path.join(dir, 'install.sh'), 'echo other\n');
            expect(checkInstallScript(dir, source)[0]).toMatch(/不一致/);
            fs.writeFileSync(path.join(dir, 'install.sh'), 'echo hi\n');
            expect(checkInstallScript(dir, source)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
