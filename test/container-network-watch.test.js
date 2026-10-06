'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNetworkManager } = require('../lib/container-network');

describe('watchStarts 事件流重连', () => {
    test('第二次连上（运行时重启过）时才调用 onReconnect，首次连接不调用', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-watch-'));
        const fake = path.join(dir, 'fake-docker.sh');
        // ps 没有容器；events 立刻退出，模拟运行时断线
        fs.writeFileSync(fake, '#!/bin/sh\ncase "$1" in\n  ps) exit 0 ;;\n  events) exit 0 ;;\n  *) exit 0 ;;\nesac\n', { mode: 0o755 });
        const manager = createNetworkManager({ command: fake, homeDir: dir, imageRef: () => 'img:1', warn: () => {} });
        let calls = 0;
        const watcher = manager.watchStarts({ onReconnect: async () => { calls += 1; } });
        try {
            await new Promise(resolve => setTimeout(resolve, 600));
            expect(calls).toBe(0);
            await new Promise(resolve => setTimeout(resolve, 3000));
            expect(calls).toBeGreaterThanOrEqual(1);
        } finally {
            watcher.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 10000);
});
