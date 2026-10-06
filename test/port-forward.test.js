'use strict';

const { containerCommand, IDLE_SECONDS } = require('../lib/port-forward');

describe('端口转发的容器内命令', () => {
    test('socat 与 node 兜底都带空闲超时', () => {
        const script = containerCommand(8080)[2];
        expect(script).toContain(`socat -T ${IDLE_SECONDS} STDIO TCP:127.0.0.1:8080`);
        expect(script).toContain(`s.setTimeout(${IDLE_SECONDS}*1000,()=>process.exit(0))`);
    });

    test('端口非法直接抛错', () => {
        expect(() => containerCommand(0)).toThrow();
        expect(() => containerCommand('a;b')).toThrow();
    });
});
