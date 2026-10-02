'use strict';

// 本地少量不可推导的状态：预检结果、验证运行 id、真机清单勾选。放 .release/state.json（已 .gitignore，不提交）。

const fs = require('fs');
const path = require('path');

function createStateStore(repoRoot) {
    const file = path.join(repoRoot, '.release', 'state.json');
    const load = () => {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (error) {
            return {};
        }
    };
    const save = patch => {
        const next = { ...load(), ...patch };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
        return next;
    };
    return { load, save, file };
}

module.exports = { createStateStore };
