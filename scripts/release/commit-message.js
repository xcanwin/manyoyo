'use strict';

// 提交说明：规则生成（本地、秒出）与容器内 Agent 生成（调用 manyoyo run 里的 commit-diff skill），网页里都可再手改。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeCommitMessage, extractAgentMessageFromCodexJsonl } = require('./versions');

const AGENT_TIMEOUT_MS = 90000;

function area(file) {
    if (/^docs\/|\.md$/.test(file)) return 'docs';
    if (/^test\/|\.test\.[jt]sx?$/.test(file)) return 'test';
    if (/^\.github\//.test(file)) return 'ci';
    if (/^frontend\//.test(file)) return 'frontend';
    if (/^(package(-lock)?\.json)$/.test(file)) return 'deps';
    return 'code';
}

/**
 * 按改动的文件给一行建议文案（≤50 字）：只改文档 → docs:，只改测试 → test:，只改 CI → ci:，其余 → feat:（可在网页里改成 fix: 等）。
 */
function ruleCommitMessage(files) {
    const list = (files || []).map(item => (typeof item === 'string' ? item : item.path)).filter(Boolean);
    if (list.length === 0) return '';
    const areas = new Set(list.map(area));
    const only = name => areas.size === 1 && areas.has(name);
    const tops = [...new Set(list.map(file => file.split('/')[0]))].slice(0, 3).join('、');
    if (only('docs')) return `docs: 更新 ${tops} 文档`;
    if (only('test')) return `test: 补充 ${tops} 用例`;
    if (only('ci')) return 'ci: 调整工作流';
    if (areas.size === 1 && areas.has('deps')) return 'chore: 更新依赖与版本';
    return `feat: 调整 ${tops}`.slice(0, 50);
}

function agentArgs(repoRoot, authPath) {
    return [
        path.join(repoRoot, 'bin', 'manyoyo.js'), 'run', '--rm-on-exit', '-q', 'full', '-y', 'cx',
        '-v', `${authPath}:/root/.codex/auth.json`,
        '--ss', "exec --skip-git-repo-check --json '$commit-diff'"
    ];
}

/**
 * 容器内 Agent 生成。异步（不阻塞控制台服务），失败返回 { message: null, reason }。
 */
function agentCommitMessage({ repoRoot, homeDir = os.homedir(), timeoutMs = AGENT_TIMEOUT_MS, spawnImpl = spawn }) {
    const authPath = path.join(homeDir, '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) {
        return Promise.resolve({ message: null, reason: `未检测到 Codex 认证文件: ${authPath}` });
    }
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const child = spawnImpl(process.execPath, agentArgs(repoRoot, authPath), { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            finish({ message: null, reason: `容器内生成超时（>${Math.floor(timeoutMs / 1000)} 秒）` });
            child.kill('SIGTERM');
        }, timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => finish({ message: null, reason: error.message || '调用 manyoyo 失败' }));
        child.on('close', status => {
            if (status !== 0) return finish({ message: null, reason: `manyoyo 退出码 ${status}${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}` });
            const message = normalizeCommitMessage(extractAgentMessageFromCodexJsonl(stdout));
            finish(message ? { message, reason: '' } : { message: null, reason: '未提取到最终提交文案' });
        });
    });
}

module.exports = { ruleCommitMessage, agentCommitMessage, agentArgs };
