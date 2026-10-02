'use strict';

// 安装器（sh）不解析 JSON：构建时把需要的值写成 install/env.sh，由 install.sh 直接 source。
// 所有值都先过白名单校验再写入，env.sh 里只有 KEY='value'，不含任何可执行内容。

// 下限暂取 13（Podman 官方包声明）；低于 26 的系统能否用 libkrun 方式运行待 M01 V7 实测后调整
const MIN_MACOS = 13;
// Linux：Ubuntu 22.04（glibc 2.35）/ Debian 12（2.36）及以上
const MIN_GLIBC = '2.35';
const MIN_FREE_MB = { full: 12000, lite: 5000 };
const MACHINE_NAME = 'podman-machine-manyoyo';

function shellValue(name, value) {
    const text = String(value);
    if (!/^[A-Za-z0-9._+:/-]*$/.test(text)) throw new Error(`install env 的值含不允许的字符: ${name}`);
    return `'${text}'`;
}

function renderInstallEnv({ version, imageVersion, arch, kind, componentInfo, platform = 'macos' }) {
    const values = {
        MANYOYO_OS: platform,
        MANYOYO_VERSION: version,
        MANYOYO_IMAGE_VERSION: imageVersion,
        MANYOYO_ARCH: arch,
        MANYOYO_KIND: kind,
        MANYOYO_MIN_MACOS: MIN_MACOS,
        MANYOYO_MIN_GLIBC: MIN_GLIBC,
        MANYOYO_MIN_FREE_MB: MIN_FREE_MB[kind] || MIN_FREE_MB.lite,
        MANYOYO_IMAGE_REF: componentInfo.image.ref,
        MANYOYO_IMAGE_FILE: componentInfo.image.file,
        MANYOYO_IMAGE_SHA: componentInfo.image.sha256,
        MANYOYO_MACHINE_NAME: MACHINE_NAME,
        MANYOYO_PODMAN_VERSION: kind === 'full' && componentInfo.podman ? componentInfo.podman.version : '',
        MANYOYO_VM_FILE: kind === 'full' && componentInfo.vmDisk ? componentInfo.vmDisk.file : '',
        MANYOYO_VM_SHA: kind === 'full' && componentInfo.vmDisk ? componentInfo.vmDisk.sha256 : ''
    };
    const lines = Object.entries(values).map(([name, value]) => `${name}=${shellValue(name, value)}`);
    return `# 由构建脚本生成，安装器 source 它；不要手改\n${lines.join('\n')}\n`;
}

module.exports = { renderInstallEnv, MIN_MACOS, MIN_GLIBC, MIN_FREE_MB, MACHINE_NAME };
