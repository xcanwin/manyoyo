'use strict';

const fs = require('fs');
const path = require('path');
const { createEgressProxy } = require('./egress-proxy');
const { createRecorder } = require('./egress-denied');

// 过滤代理 sidecar 容器里的入口（宿主机把这几个文件只读挂进来，见 egress-sidecar.js）。
// 数据目录（只读）：clients.json（来源 IP → 容器 id + 策略，宿主机在每次下发规则时原子替换）、upstream.txt（可选，上游代理）；
// 拒绝记录目录（读写）：<容器 id>.jsonl。
const CLIENTS_FILE = 'clients.json';
const UPSTREAM_FILE = 'upstream.txt';
const RELOAD_CHECK_MS = 500;

function loadClients(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const clients = parsed && typeof parsed.clients === 'object' && parsed.clients ? parsed.clients : {};
        return new Map(Object.entries(clients));
    } catch (e) {
        return new Map(); // 读不到 / 损坏：谁都不认识，全部 403（失败即关闭）
    }
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.deniedDir
 * @param {number} options.port
 * @param {string} [options.host]
 * @param {(host: string) => Promise<string[]>} [options.lookup]
 */
async function start(options) {
    const clientsFile = path.join(options.dataDir, CLIENTS_FILE);
    // 上游代理：upstream.txt 变了就热更新（CLI 与 serve 的环境可能不同，不能为此重建容器）
    const upstreamFile = path.join(options.dataDir, UPSTREAM_FILE);
    let upstream = '';
    let upstreamSig = '';
    let upstreamCheckedAt = 0;
    const getUpstream = () => {
        const nowMs = Date.now();
        if (nowMs - upstreamCheckedAt < RELOAD_CHECK_MS) return upstream;
        upstreamCheckedAt = nowMs;
        try {
            const stat = fs.statSync(upstreamFile);
            const sig = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            if (sig !== upstreamSig) {
                upstreamSig = sig;
                upstream = fs.readFileSync(upstreamFile, 'utf-8').trim();
            }
        } catch (e) {
            upstreamSig = '';
            upstream = '';
        }
        return upstream;
    };

    let clients = loadClients(clientsFile);
    let signature = '';
    let checkedAt = 0;
    const refresh = () => {
        const nowMs = Date.now();
        if (nowMs - checkedAt < RELOAD_CHECK_MS) return;
        checkedAt = nowMs;
        try {
            const stat = fs.statSync(clientsFile);
            const next = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            if (next !== signature) {
                signature = next;
                clients = loadClients(clientsFile);
            }
        } catch (e) {
            signature = '';
            clients = new Map();
        }
    };

    const recorder = createRecorder({ dir: options.deniedDir });
    const proxy = createEgressProxy({
        upstream: getUpstream,
        lookup: options.lookup,
        getClient: ip => {
            refresh();
            const entry = clients.get(ip);
            return entry ? { ...entry } : null;
        },
        onDenied: event => recorder.record(event)
    });
    const port = await proxy.start({ host: options.host || '0.0.0.0', port: options.port });
    return {
        port,
        stop: async () => { recorder.stop(); await proxy.stop(); }
    };
}

if (require.main === module) {
    start({
        dataDir: process.env.EGRESS_DATA_DIR || '/data',
        deniedDir: process.env.EGRESS_DENIED_DIR || '/denied',
        port: Number(process.env.EGRESS_PORT) || 3128
    }).then(server => {
        process.stdout.write(`egress-proxy ready ${server.port}\n`);
        const shutdown = () => server.stop().finally(() => process.exit(0));
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }).catch(error => {
        process.stderr.write(`egress-proxy failed: ${error.message}\n`);
        process.exit(1);
    });
}

module.exports = { start, CLIENTS_FILE, UPSTREAM_FILE };
