'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

describe('CodeMirror 编辑器产物自动生成', () => {
    test('package.json 声明 prepack/prepare 钩子自动构建编辑器', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
        expect(pkg.scripts.prepack).toBe('npm run build:web-editor && npm run build:web-shadcn');
        expect(pkg.scripts.prepare).toBe('npm run build:web-editor');
    });

    test('构建脚本启用 minify', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'scripts/build-web-code-editor.js'), 'utf-8');
        expect(source).toMatch(/minify:\s*true/);
    });

    test('.gitignore 排除生成的 codemirror.bundle.js', () => {
        const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
        expect(gitignore).toMatch(/lib\/web\/frontend\/codemirror\.bundle\.js/);
    });

    test('codemirror.bundle.js 不再被 git 追踪', () => {
        const result = spawnSync('git', ['ls-files', 'lib/web/frontend/codemirror.bundle.js'], {
            cwd: repoRoot,
            encoding: 'utf-8'
        });
        expect(result.stdout.trim()).toBe('');
    });
});

describe('shadcn 预览版前端产物自动生成', () => {
    test('package.json 声明 build:web-shadcn / dev:web-shadcn 脚本', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
        expect(pkg.scripts['build:web-shadcn']).toBe('node scripts/build-web-shadcn.js');
        expect(pkg.scripts['dev:web-shadcn']).toBe('node scripts/dev-web-shadcn.js');
    });

    test('.gitignore 排除生成的 shadcn.html', () => {
        const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');
        expect(gitignore).toMatch(/lib\/web\/frontend\/shadcn\.html/);
    });

    test('shadcn.html 不再被 git 追踪', () => {
        const result = spawnSync('git', ['ls-files', 'lib/web/frontend/shadcn.html'], {
            cwd: repoRoot,
            encoding: 'utf-8'
        });
        expect(result.stdout.trim()).toBe('');
    });

    test('frontend-shadcn 源码目录未被 git 追踪 node_modules/dist', () => {
        const result = spawnSync('git', ['ls-files', 'frontend-shadcn'], {
            cwd: repoRoot,
            encoding: 'utf-8'
        });
        const tracked = result.stdout.trim().split('\n').filter(Boolean);
        expect(tracked.some(file => file.includes('node_modules/'))).toBe(false);
        expect(tracked.some(file => file.includes('/dist/'))).toBe(false);
    });
});
