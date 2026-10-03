'use strict';

const fs = require('fs');

// rootless podman 的默认网络组件：4.x 用 slirp4netns，5.x 起用 pasta
const PACKAGE_OF = { slirp4netns: 'slirp4netns', pasta: 'passt' };

function parsePodmanMajor(versionText) {
    const match = /(\d+)\.\d+/.exec(String(versionText || ''));
    return match ? Number(match[1]) : null;
}

function defaultNetworkComponent(major) {
    return major !== null && major >= 5 ? 'pasta' : 'slirp4netns';
}

function readOsRelease() {
    try {
        return fs.readFileSync('/etc/os-release', 'utf8');
    } catch (e) {
        return '';
    }
}

function hasCommand(name) {
    return String(process.env.PATH || '').split(':').some(dir => dir && fs.existsSync(`${dir}/${name}`));
}

// 与 scripts/offline/install.sh 的 Linux 分支保持同一套规则；不认识的发行版返回 null（只给说明）
function installCommand(component, { osRelease = readOsRelease(), hasDnf = hasCommand('dnf') } = {}) {
    const pkg = PACKAGE_OF[component] || component;
    const ids = (String(osRelease).match(/^(?:ID|ID_LIKE)=(.*)$/gm) || [])
        .map(line => line.split('=')[1].replace(/["']/g, '').toLowerCase())
        .join(' ')
        .split(/\s+/);
    if (ids.some(id => id === 'debian' || id === 'ubuntu')) return `sudo apt-get install -y ${pkg}`;
    if (ids.some(id => ['fedora', 'rhel', 'centos'].includes(id))) return `sudo ${hasDnf ? 'dnf' : 'yum'} install -y ${pkg}`;
    return null;
}

function describeMissing(component, options) {
    const pkg = PACKAGE_OF[component] || component;
    const command = installCommand(component, options);
    return {
        reason: `rootless Podman 缺少默认网络组件 ${component}，容器无法创建网络。`,
        action: command ? `请执行: ${command}` : `请用系统包管理器安装 ${pkg}（提供 ${component}）。`
    };
}

/**
 * 检查 rootless podman 的默认网络组件是否存在（只在 Linux 的 podman 上检查）。
 * @returns {Promise<null|{component: string, reason: string, action: string}>} null 表示无需处理
 */
async function checkRootlessNetwork(runCommand, { command, env, timeout, platform = process.platform } = {}) {
    if (platform !== 'linux' || !/(^|\/)podman$/.test(String(command || ''))) return null;
    const run = async args => String(await runCommand(command, args, { env, timeout }) || '').trim();
    try {
        if ((await run(['info', '--format', '{{.Host.Security.Rootless}}'])) !== 'true') return null;
        const component = defaultNetworkComponent(parsePodmanMajor(await run(['--version'])));
        const field = component === 'pasta' ? 'Pasta' : 'Slirp4NetNS';
        if (await run(['info', '--format', `{{.Host.${field}.Executable}}`])) return { component, missing: false };
        return { component, missing: true, ...describeMissing(component) };
    } catch (e) {
        return null;
    }
}

module.exports = { parsePodmanMajor, defaultNetworkComponent, installCommand, describeMissing, checkRootlessNetwork };
