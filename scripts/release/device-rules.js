'use strict';

// 发布前真机检查：按“自上个 tag 以来改了哪些文件”匹配区域规则。规则是数据，便于测试与调整。
// 只匹配会在用户机器上运行的文件；只在 CI 里运行的构建脚本与 workflow、维护者的发布控制台页面不算（release-verify 在真实 macOS 上覆盖）。

const CI_ONLY = new Set(['scripts/offline/build.js', 'scripts/offline/stage.js']);

const DEVICE_RULES = [
    {
        id: 'plugin',
        title: 'Playwright 插件：默认 / headed / chrome / vnc 四种模式都在容器里打开一个网页并截图',
        match: file => file.startsWith('lib/plugin/') || file.startsWith('docker/res/playwright/')
    },
    {
        id: 'install',
        title: '安装器：新建 macOS 用户，执行一键安装；向导走完',
        match: file => file === 'scripts/install.sh' || file.startsWith('scripts/offline/') || file === 'lib/post-install.js' || file === 'lib/headless.js'
    },
    {
        id: 'runtime',
        title: '容器运行时：私有 Podman machine 冷启动；重启后 manyoyo run',
        match: file => ['lib/container-runtime.js', 'lib/runtime-heal.js', 'lib/rootless-network.js', 'scripts/offline/lock.js'].includes(file)
    },
    {
        id: 'web',
        title: '网页服务与前端：浏览器向导 + 一次 Agent 对话 + 登出/登录',
        match: file => file.startsWith('lib/web/') || (file.startsWith('frontend/') && !file.startsWith('frontend/src/release/') && file !== 'frontend/release.html')
    }
];

/** 命中的规则（保持 DEVICE_RULES 的顺序）；每条附带命中的文件，便于展示 */
function matchDeviceRules(files) {
    const list = (files || []).filter(file => !CI_ONLY.has(file) && !/^scripts\/offline\/scan-allowlist/.test(file));
    return DEVICE_RULES
        .map(rule => ({ id: rule.id, title: rule.title, files: list.filter(rule.match) }))
        .filter(rule => rule.files.length > 0);
}

module.exports = { DEVICE_RULES, matchDeviceRules };
