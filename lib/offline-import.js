'use strict';

// 离线安装器在后台导入镜像时会写 ~/.manyoyo/runtime/import/loading.json（含 pid）。
// serve / CLI 看到它就等待，不要同时去 ghcr 拉同一个镜像；导入失败或进程消失则视为没有进行中的导入。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function getImportMarkerPath(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'runtime', 'import', 'loading.json');
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

// pid 可能在导入器被强杀后被无关进程复用：必须确认命令行里是后台导入脚本 finish.sh
function isImportProcess(pid) {
    try {
        const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).stdout || '';
        return /finish\.sh/.test(command);
    } catch (error) {
        return false;
    }
}

function readImportState(homeDir = os.homedir(), options = {}) {
    const isImporter = options.isImporter || isImportProcess;
    try {
        const marker = JSON.parse(fs.readFileSync(getImportMarkerPath(homeDir), 'utf-8'));
        if (Number.isInteger(marker.pid) && marker.pid > 0 && isAlive(marker.pid) && isImporter(marker.pid)) {
            return { active: true, message: String(marker.message || '正在导入离线镜像') };
        }
    } catch (error) {
        // 没有标记文件就是没有导入
    }
    return { active: false, message: '' };
}

async function waitForImport({ homeDir, readState, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onWait = () => {}, timeoutMs = 10 * 60 * 1000, pollMs = 1000 } = {}) {
    let waited = 0;
    const read = readState || (() => readImportState(homeDir));
    let state = read();
    if (state.active) onWait(state);
    while (state.active && waited < timeoutMs) {
        await sleep(pollMs);
        waited += pollMs;
        state = read();
    }
    return !state.active;
}

module.exports = { getImportMarkerPath, readImportState, waitForImport, isImportProcess };
