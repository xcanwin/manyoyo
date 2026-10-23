'use strict';

const PROBE_AGENTS = ['claude', 'codex', 'gemini', 'opencode'];
const PROBE_SCRIPT = `for c in ${PROBE_AGENTS.join(' ')}; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done`;
const PROBE_TIMEOUT_MS = 30000;

/**
 * 探测镜像里装了哪些 Agent CLI。结果按镜像 ID 缓存，同一镜像只探测一次；
 * 同时到来的请求共用一次探测。拿不到结果时返回 null（未知，不缓存）。
 * exec(args, { timeout }) → Promise<stdout>，抛错表示失败。
 */
function createImageAgentProbe(exec) {
    const cache = new Map();
    const inflight = new Map();

    async function run(imageRef) {
        let imageId = '';
        try {
            imageId = String(await exec(['image', 'inspect', '--format', '{{.Id}}', imageRef], { timeout: 10000 })).trim();
        } catch (e) {
            return null;
        }
        if (!imageId) return null;
        if (cache.has(imageId)) return cache.get(imageId);
        try {
            const out = await exec([
                'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', imageRef, '-c', PROBE_SCRIPT
            ], { timeout: PROBE_TIMEOUT_MS });
            const found = String(out).split('\n').map(line => line.trim()).filter(line => PROBE_AGENTS.includes(line));
            cache.set(imageId, found);
            return found;
        } catch (e) {
            return null;
        }
    }

    return function probeImageAgents(imageRef) {
        if (inflight.has(imageRef)) return inflight.get(imageRef);
        const promise = run(imageRef).finally(() => inflight.delete(imageRef));
        inflight.set(imageRef, promise);
        return promise;
    };
}

module.exports = { createImageAgentProbe, PROBE_AGENTS };
