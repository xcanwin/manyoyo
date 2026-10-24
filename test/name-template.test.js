const os = require('os');
const path = require('path');
const { formatNow, expandTemplate, resolveQuickChatPath, expandHome } = require('../lib/name-template');
const { resolveRuntimeConfig } = require('../lib/runtime-resolver');

describe('name-template', () => {
    test('formatNow 是 年月日-时分秒', () => {
        expect(formatNow(new Date(2026, 9, 24, 23, 9, 5))).toBe('20261024-230905');
        expect(formatNow()).toMatch(/^\d{8}-\d{6}$/);
    });

    test('expandTemplate：{now}、${now}、{quickChatPath}，并标出是否按模板生成', () => {
        const vars = { now: '20261024-230905', quickChatPath: '/root/manyoyo_work/' };
        expect(expandTemplate('my-easy-{now}', vars)).toEqual({ value: 'my-easy-20261024-230905', templated: true });
        expect(expandTemplate('x-${now}', vars).value).toBe('x-20261024-230905');
        expect(expandTemplate('{quickChatPath}/{now}', vars).value).toBe('/root/manyoyo_work/20261024-230905');
        expect(expandTemplate('/srv/mine', vars)).toEqual({ value: '/srv/mine', templated: false });
        expect(expandTemplate(undefined, vars)).toEqual({ value: undefined, templated: false });
    });

    test('resolveQuickChatPath：展开 ~、去掉尾斜杠；没配置用默认目录', () => {
        expect(resolveQuickChatPath({ serve: { quickChat: { path: '~/manyoyo_work/' } } }, { homeDir: '/h/u' })).toBe('/h/u/manyoyo_work');
        expect(resolveQuickChatPath({}, { homeDir: '/h/u', defaultDir: '/h/u/.manyoyo/work' })).toBe('/h/u/.manyoyo/work');
        expect(expandHome('~', '/h/u')).toBe('/h/u');
    });

    test('resolveRuntimeConfig：容器名与目录用同一个时间戳，并标出目录是按模板生成的', () => {
        const base = {
            cliOptions: {},
            globalConfig: { containerName: 'my-easy-{now}', hostPath: '{quickChatPath}/{now}' },
            defaults: { hostPath: '/cwd', containerName: 'my-x', containerPath: '', imageName: 'i', imageVersion: '1.0.0-common' },
            pickConfigValue: (...values) => values.find(Boolean),
            resolveContainerNameTemplate: value => value,
            normalizeCommandSuffix: value => value,
            normalizeJsonEnvMap: () => ({}),
            normalizeCliEnvMap: () => ({}),
            mergeArrayConfig: () => [],
            normalizeVolume: value => value,
            parseServerListen: () => ({ host: '', port: 0 }),
            templateVars: { now: '20261024-230905', quickChatPath: path.join(os.tmpdir(), 'qc') }
        };
        const resolved = resolveRuntimeConfig(base);
        expect(resolved.containerName).toBe('my-easy-20261024-230905');
        expect(resolved.hostPath).toBe(path.join(os.tmpdir(), 'qc', '20261024-230905'));
        expect(resolved.hostPathTemplated).toBe(true);
        const fixed = resolveRuntimeConfig({ ...base, globalConfig: { hostPath: '/srv/mine' } });
        expect(fixed.hostPathTemplated).toBe(false);
    });

    test('命令行 config show 展开模板，但只是查看，不建目录', () => {
        const fs = require('fs');
        const { execFileSync } = require('child_process');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-tpl-cli-'));
        try {
            fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
            fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
                hostPath: '{quickChatPath}/{now}',
                containerName: 'my-easy-{now}',
                serve: { quickChat: { path: path.join(home, 'qc'), run: 'x' } }
            }));
            const output = execFileSync('node', [path.join(__dirname, '..', 'bin', 'manyoyo.js'), 'config', 'show'], {
                env: { ...process.env, HOME: home }, encoding: 'utf8'
            });
            const config = JSON.parse(output);
            const stamp = config.containerName.replace('my-easy-', '');
            expect(stamp).toMatch(/^\d{8}-\d{6}$/);
            expect(config.hostPath).toBe(path.join(home, 'qc', stamp));
            expect(fs.existsSync(path.join(home, 'qc'))).toBe(false);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
