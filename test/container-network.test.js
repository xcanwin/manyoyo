'use strict';

const { subnetOf, bridgeOf, parseHostsAndResolv, parseUrlHostPort } = require('../lib/container-network');

describe('container-network 纯函数', () => {
    test('subnetOf：按前缀算网段；前缀非法返回空', () => {
        expect(subnetOf('10.89.0.3', 24)).toBe('10.89.0.0/24');
        expect(subnetOf('172.18.5.9', 16)).toBe('172.18.0.0/16');
        expect(subnetOf('10.89.0.3', 0)).toBe('');
        expect(subnetOf('not-an-ip', 24)).toBe('');
    });

    test('bridgeOf：优先 manyoyo 网络；slirp4netns（无 IP）返回 null；有 IP 无网段信息时抛错（失败即关闭）', () => {
        const info = networks => ({ NetworkSettings: { Networks: networks } });
        expect(bridgeOf(info({ podman: { IPAddress: '' } }))).toBeNull();
        expect(bridgeOf(info({
            bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1', IPPrefixLen: 16 },
            manyoyo: { IPAddress: '10.89.0.5', Gateway: '10.89.0.1', IPPrefixLen: 24 }
        }))).toEqual({ ip: '10.89.0.5', gateway: '10.89.0.1', subnet: '10.89.0.0/24' });
        expect(() => bridgeOf(info({ manyoyo: { IPAddress: '10.89.0.5', Gateway: '10.89.0.1' } }))).toThrow(/网段/);
    });

    test('parseHostsAndResolv：宿主机别名、DNS（跳过 loopback）', () => {
        const parsed = parseHostsAndResolv([
            '127.0.0.1\tlocalhost',
            '172.16.99.129\thost.containers.internal host.docker.internal',
            '10.89.0.2\tabc',
            'search localdomain',
            'nameserver 172.16.99.2',
            'nameserver 127.0.0.53',
            'nameserver 2001:db8::1'
        ].join('\n'));
        expect(parsed).toEqual({ hostIps: ['172.16.99.129'], dnsServers: ['172.16.99.2', '2001:db8::1'] });
    });

    test('parseUrlHostPort：代理 URL 与无协议写法', () => {
        expect(parseUrlHostPort('http://172.16.99.1:10808/')).toEqual({ host: '172.16.99.1', port: 10808 });
        expect(parseUrlHostPort('https://mirrors.aliyun.com')).toEqual({ host: 'mirrors.aliyun.com', port: 443 });
        expect(parseUrlHostPort('proxy.local:3128')).toEqual({ host: 'proxy.local', port: 3128 });
        expect(parseUrlHostPort('http://[fd00::1]:8080')).toEqual({ host: 'fd00::1', port: 8080 });
        expect(parseUrlHostPort('')).toBeNull();
    });
});
