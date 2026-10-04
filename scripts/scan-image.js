#!/usr/bin/env node
'use strict';

// 本地预扫发布镜像：npm run scan:image -- [镜像]（默认 ghcr.io/xcanwin/manyoyo:<package.json 的 imageVersion>）
// 镜像内容变化（新增系统包等）后，先在本机用 CI 同一份允许列表扫一遍，避免到 CI 才发现缺项。
// 不带 --auto-identity：本机用户名（如 test）会在 libgcrypt 等系统库里误报 build-identity；CI 上才有意义。
// 流程：选容器运行时 → save 到临时目录 → scan-release-artifacts.js → 清理临时文件。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { selectContainerRuntime, mergeRuntimeEnv } = require('../lib/container-runtime');

const ROOT = path.join(__dirname, '..');
const DEFAULT_ALLOWLIST = path.join(ROOT, 'scripts', 'offline', 'scan-allowlist-image.json');
const SCANNER = path.join(__dirname, 'scan-release-artifacts.js');

function parseArgs(argv) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const images = [];
    for (const arg of argv) {
        if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
        images.push(arg);
    }
    if (images.length > 1) throw new Error('只能指定一个镜像');
    return { image: images[0] || `ghcr.io/xcanwin/manyoyo:${pkg.imageVersion}` };
}

function defaultSave(command, args, env) {
    return spawnSync(command, args, { stdio: 'inherit', env }).status;
}

// 子进程被信号杀掉（如 OOM）时 status 是 null，必须按失败处理，不能让 process.exit(null) 变成 0
function exitCodeOf(status) {
    return status === null || status === undefined ? 1 : status;
}

function defaultScan(args) {
    return exitCodeOf(spawnSync(process.execPath, [SCANNER, ...args], { stdio: 'inherit' }).status);
}

/** @returns {Promise<number>} 扫描器退出码（0 通过，1 命中或有未扫描内容） */
async function scanImage({ image, runtime, save = defaultSave, scan = defaultScan }) {
    const rt = runtime || selectContainerRuntime();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-scan-image-'));
    const archive = path.join(tmp, 'image.tar');
    try {
        console.log(`保存镜像 ${image}（${rt.command}）…`);
        const saved = save(rt.command, ['save', '-o', archive, image], mergeRuntimeEnv(rt.env));
        if (saved !== 0) throw new Error(`保存镜像失败（${rt.command} save 退出码 ${saved}）：请确认本机有 ${image}`);
        return scan(['--no-inventory', '--allowlist', DEFAULT_ALLOWLIST, archive]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function main(argv) {
    try {
        const { image } = parseArgs(argv);
        return await scanImage({ image });
    } catch (error) {
        console.error(error.message);
        return 2;
    }
}

module.exports = { parseArgs, scanImage, exitCodeOf, DEFAULT_ALLOWLIST };

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code));
}
