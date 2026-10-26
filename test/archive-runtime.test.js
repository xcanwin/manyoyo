'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliRuntime } = require('../lib/archive/runtime');

test('运行时子进程继承本进程环境；额外变量叠加其上（env 为 {} 或只有几个变量时不能丢 PATH / HOME）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rt-'));
    const fake = path.join(dir, 'fake-rt');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s|%s" "$HOME" "${EXTRA_X:-}" "$PATH"\n', { mode: 0o755 });
    try {
        for (const extra of [{}, undefined, { EXTRA_X: 'x' }]) {
            const out = createCliRuntime({ command: fake, env: extra }).diff('c');
            const [home, x, pathValue] = out.split('|');
            expect(home).toBe(process.env.HOME);
            expect(pathValue).toBe(process.env.PATH);
            expect(x).toBe(extra && extra.EXTRA_X ? 'x' : '');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
