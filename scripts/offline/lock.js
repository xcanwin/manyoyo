'use strict';

// 离线包组件的锁定版本与 SHA256。升级任何组件都是一次有意的改动：改这里并更新哈希。
// 哈希来源：Node 来自 nodejs.org 的 SHASUMS256.txt；Podman 来自 GitHub Release 资产的 digest（与 Release 的 shasums 文件一致）。

const NODE_VERSION = '24.21.0';

const LOCK = {
    node: {
        version: NODE_VERSION,
        baseUrl: `https://nodejs.org/dist/v${NODE_VERSION}`,
        // 用 .tar.gz：macOS 与 Linux 的 tar 都能直接解开，不依赖 xz
        arch: {
            arm64: {
                file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
                sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057'
            },
            x64: {
                file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
                sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'
            }
        }
    },
    // Apple Silicon 用 6.x；Intel 只有 5.8.x 仍提供 amd64 安装包（方案决策）
    podman: {
        arm64: {
            version: '6.1.3',
            file: 'podman-installer-macos-arm64.pkg',
            url: 'https://github.com/containers/podman/releases/download/v6.1.3/podman-installer-macos-arm64.pkg',
            sha256: '84400d0539b5df0b2f00e9165463d4c17de51933244d1ea4b9cc54d8f05e4de9',
            // arm64 才有 krunkit（libkrun），需要打补丁，见 podman.js
            machineProvider: 'libkrun'
        },
        x64: {
            version: '5.8.8',
            file: 'podman-installer-macos-amd64.pkg',
            url: 'https://github.com/containers/podman/releases/download/v5.8.8/podman-installer-macos-amd64.pkg',
            sha256: '0bd0b3e2ee16ebe9152b3cc8f555b3701ddae15f6f7e3df1dc68343d29eadc06',
            machineProvider: 'applehv'
        }
    }
};

const ARCHES = Object.keys(LOCK.node.arch);

function resolveLock(arch) {
    if (!ARCHES.includes(arch)) {
        throw new Error(`不支持的架构: ${arch}（可选 ${ARCHES.join(' / ')}）`);
    }
    const node = LOCK.node.arch[arch];
    return {
        node: { version: LOCK.node.version, file: node.file, url: `${LOCK.node.baseUrl}/${node.file}`, sha256: node.sha256 },
        podman: { ...LOCK.podman[arch] }
    };
}

module.exports = { LOCK, ARCHES, resolveLock };
