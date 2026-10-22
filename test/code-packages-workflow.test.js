'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, '.github/workflows/code-packages.yml'), 'utf8');

function jobBlock(name) {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

function condition(block) {
    const match = /^ {4}if: (.+)$/m.exec(block);
    expect(match).not.toBeNull();
    return match[1];
}

// 把 needs.<job>.result 换成具体结果后求值（条件里只有 == / && / 字符串）
function evaluate(expression, results) {
    const js = expression.replace(/needs\.([a-z-]+)\.result/g, (_, job) => JSON.stringify(results[job])).replace(/==/g, '===');
    return Function(`return (${js});`)();
}

describe('code-packages workflow', () => {
    test('触发：只有 main 推送与手动触发，没有 tag / PR / 定时 / paths 之类的临时触发残留', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nconcurrency:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).toMatch(/push:\s*\n\s*branches: \[main\]/);
        expect(onBlock).not.toMatch(/^\s*(pull_request|schedule|release|workflow_call|workflow_run):/m);
        expect(onBlock).not.toMatch(/^\s*(paths|tags):/m);
    });

    test('并发：同一个 ref 只留最新一次', () => {
        expect(text).toMatch(/concurrency:\s*\n\s*group: code-packages-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: true/);
    });

    test('权限：默认只读，只有 publish 有 contents: write', () => {
        expect(text).toMatch(/^permissions:\s*\n {2}contents: read/m);
        expect(text.match(/contents: write/g)).toHaveLength(1);
        expect(jobBlock('publish')).toContain('contents: write');
        expect(jobBlock('build')).not.toContain('write');
        expect(jobBlock('test')).not.toContain('write');
        expect(text).not.toMatch(/packages: write|actions: write|id-token/);
    });

    test('test 复用 ci.yml；build / publish 的 if 都显式判断上游 result == success', () => {
        expect(jobBlock('test')).toContain('uses: ./.github/workflows/ci.yml');
        expect(condition(jobBlock('build'))).toBe("needs.test.result == 'success'");
        expect(condition(jobBlock('publish'))).toBe("needs.test.result == 'success' && needs.build.result == 'success'");
    });

    test('真值表：上游 × 本步是否运行', () => {
        const build = condition(jobBlock('build'));
        const publish = condition(jobBlock('publish'));
        const run = (test, buildResult) => ({
            build: evaluate(build, { test }),
            publish: evaluate(publish, { test, build: buildResult })
        });
        expect(run('success', 'success')).toEqual({ build: true, publish: true });
        expect(run('success', 'failure')).toEqual({ build: true, publish: false });
        expect(run('success', 'skipped')).toEqual({ build: true, publish: false });
        expect(run('failure', 'skipped')).toEqual({ build: false, publish: false });
        expect(run('cancelled', 'skipped')).toEqual({ build: false, publish: false });
        expect(run('skipped', 'skipped')).toEqual({ build: false, publish: false });
    });

    test('发布前核对该分支最新提交，落后就跳过（不失败），且发布步骤带这个条件', () => {
        const publish = jobBlock('publish');
        expect(publish).toContain('git ls-remote origin "refs/heads/${BRANCH}"');
        expect(publish).toContain('跳过这次发布');
        const step = publish.slice(publish.indexOf('- name: Publish to the rolling pre-release'));
        expect(step).toContain("if: steps.latest.outputs.current == 'true'");
        expect(publish.indexOf('git ls-remote')).toBeLessThan(publish.indexOf('gh release create'));
    });

    test('预发布：tag 指向根提交（不是 github.sha）、prerelease、不当 latest', () => {
        const publish = jobBlock('publish');
        expect(publish).toContain('ROOT="$(git rev-list --max-parents=0 HEAD | tail -n 1)"');
        const create = publish.slice(publish.indexOf('gh release create'), publish.indexOf('gh release create') + 400);
        expect(create).toContain('--target "${ROOT}"');
        expect(create).not.toMatch(/--target "\$\{COMMIT\}"|github\.sha/);
        expect(create).toContain('--prerelease --latest=false');
        expect(publish).toContain('fetch-depth: 0');
    });

    test('上传顺序：先传四个包，再传 CODE.json，最后才删更旧的包；保留“本次 + 上一次”两套', () => {
        const publish = jobBlock('publish');
        const packages = publish.indexOf('gh release upload "${TAG}" dist-code/manyoyo-code-*.tar.gz --clobber');
        const info = publish.indexOf('gh release upload "${TAG}" dist-code/CODE.json --clobber');
        const prune = publish.indexOf('gh release delete-asset');
        const prev = publish.indexOf('gh release download "${TAG}" --pattern CODE.json');
        expect(packages).toBeGreaterThan(-1);
        expect(prev).toBeGreaterThan(-1);
        expect(prev).toBeLessThan(packages);
        expect(packages).toBeLessThan(info);
        expect(info).toBeLessThan(prune);
        expect(publish).toContain('manyoyo-code-"${NEW7}"-*|manyoyo-code-"${PREV7:-none}"-*|CODE.json) ;;');
    });

    test('分支名只经环境变量进入脚本，不插值进 run（防注入）', () => {
        const interpolations = text.match(/\$\{\{ github\.ref_name \}\}/g) || [];
        const envLines = text.match(/^\s+BRANCH: \$\{\{ github\.ref_name \}\}$/gm) || [];
        expect(interpolations).toHaveLength(envLines.length);
        expect(envLines.length).toBe(2);
        expect(text).not.toMatch(/\$\{\{ (github\.head_ref|github\.event\.[a-z_.]*(title|body|message|name)[a-z_.]*) \}\}/);
    });

    test('构建：分支名校验、前端只构建一次、镜像探测、隐私扫描、冒烟在上传之前', () => {
        const build = jobBlock('build');
        const order = ['isValidBranch', 'npm run build:web', 'docker manifest inspect', 'scripts/offline/build-code.js', 'scan-release-artifacts.js', 'Smoke the linux-x64 package', 'actions/upload-artifact'].map(item => build.indexOf(item));
        order.forEach(index => expect(index).toBeGreaterThan(-1));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(build).toContain("MANYOYO_SKIP_WEB_BUILD: '1'");
        expect(build).toContain('scripts/offline/scan-allowlist-code.json');
        expect(build).toContain('code-work/staging');
    });

    test('不发布到别处：不推送、不打 tag、不发 npm、不公开 Release', () => {
        expect(text).not.toMatch(/git push|git tag|npm publish|--draft=false|gh release edit|--latest(?!=false)|gh workflow run/);
    });

    test('runner 固定版本，action 主版本与其它 workflow 一致', () => {
        for (const match of text.matchAll(/runs-on:\s*(\S+)/g)) expect(match[1]).toBe('ubuntu-24.04');
        expect(text).toContain('actions/checkout@v7');
        expect(text).toContain('actions/setup-node@v7');
        expect(text).toContain('actions/upload-artifact@v7');
        expect(text).toContain('actions/download-artifact@v8');
    });
});

describe('代码版预发布与正式发布互不影响（前提断言，别让它们被悄悄改掉）', () => {
    test('npm-publish.yml 跳过预发布', () => {
        const npmPublish = fs.readFileSync(path.join(root, '.github/workflows/npm-publish.yml'), 'utf8');
        expect(npmPublish).toContain('!github.event.release.prerelease');
    });

    test('install.sh 与客户端都按 releases/latest 找正式版；预发布不会成为 latest', () => {
        expect(fs.readFileSync(path.join(root, 'scripts/install.sh'), 'utf8')).toContain('releases/latest');
        expect(fs.readFileSync(path.join(root, 'lib/app-update.js'), 'utf8')).toContain('releases/latest');
        expect(text).toContain('--prerelease --latest=false');
    });

    test('发布流水线与发布控制台不引用 code-packages', () => {
        for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => name !== 'code-packages.yml')) {
            expect(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')).not.toContain('code-packages');
        }
    });
});
