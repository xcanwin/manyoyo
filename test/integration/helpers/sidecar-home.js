'use strict';

// 过滤代理 sidecar 的固定地址按 HOME 哈希只分 5 个槽位（lib/egress-sidecar.js 的 chooseSidecarIp）。
// 开发机上通常还有一个真实 HOME 的 sidecar 常驻，并行的测试文件也各起一个：随机临时 HOME 每次约 20% 撞地址，
// 表现为 “requested IP address 10.89.0.25x is not available”。这里生成临时 HOME 时避开：
//   1. 当前运行时里已存在的 sidecar 占的槽位；2. 本机其他测试进程刚领走、还没起 sidecar 的槽位（tmp 下的占位文件）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sidecarName } = require('../../../lib/egress-sidecar');

const SLOTS = 5;
const SLOT_DIR = path.join(os.tmpdir(), 'manyoyo-it-sidecar-slots');

function slotOfHash(hash) {
    return parseInt(hash, 16) % SLOTS;
}

function slotOfHome(home) {
    return slotOfHash(sidecarName(home).replace(/^manyoyo-egress-/, ''));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

// 运行中的 sidecar 占的槽位（真正会撞地址的）与其他测试进程刚领走的槽位分开返回
function occupiedSlots() {
    const sidecars = new Set();
    for (const runtime of ['podman', 'docker']) {
        const result = spawnSync(runtime, ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf-8' });
        if (result.status !== 0) continue;
        for (const name of String(result.stdout || '').split('\n')) {
            const m = /^manyoyo-egress-([0-9a-f]{8})$/.exec(name.trim());
            if (m) sidecars.add(slotOfHash(m[1]));
        }
    }
    const reserved = new Set();
    fs.mkdirSync(SLOT_DIR, { recursive: true });
    for (const file of fs.readdirSync(SLOT_DIR)) {
        const m = /^(\d+)\.(\d+)$/.exec(file);
        if (!m) continue;
        const pid = Number(m[2]);
        if (pid === process.pid) continue;
        if (alive(pid)) reserved.add(Number(m[1]));
        else fs.rmSync(path.join(SLOT_DIR, file), { force: true });
    }
    return { sidecars, reserved };
}

/**
 * 建一个临时 HOME，保证它的 sidecar 槽位没被占用；槽位在本进程退出时释放。
 * 槽位全被占了就退回普通临时目录（和以前一样，可能撞地址）。
 */
function makeSidecarSafeHome(prefix) {
    const { sidecars, reserved } = occupiedSlots();
    // 优先避开两者；全满时至少避开运行中的 sidecar
    let taken = new Set([...sidecars, ...reserved]);
    if (taken.size >= SLOTS) taken = sidecars;
    for (let attempt = 0; attempt < 50 && taken.size < SLOTS; attempt += 1) {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        const slot = slotOfHome(home);
        if (taken.has(slot)) {
            fs.rmSync(home, { recursive: true, force: true });
            continue;
        }
        // 每个进程只留一个占位（最近这个 HOME 的槽位）：同一文件里先后建的 HOME 不会把槽位越占越多
        for (const file of fs.readdirSync(SLOT_DIR)) {
            if (file.endsWith(`.${process.pid}`)) fs.rmSync(path.join(SLOT_DIR, file), { force: true });
        }
        const marker = path.join(SLOT_DIR, `${slot}.${process.pid}`);
        fs.writeFileSync(marker, home);
        if (!makeSidecarSafeHome.cleanup) {
            makeSidecarSafeHome.cleanup = true;
            process.once('exit', () => {
                for (const file of fs.readdirSync(SLOT_DIR)) {
                    if (file.endsWith(`.${process.pid}`)) fs.rmSync(path.join(SLOT_DIR, file), { force: true });
                }
            });
        }
        return home;
    }
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { makeSidecarSafeHome, slotOfHome, occupiedSlots };
