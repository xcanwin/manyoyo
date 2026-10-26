'use strict';

const plan = require('../lib/archive/plan');

describe('lib/archive/plan', () => {
    test('档位 → 内容项；手动勾选正好等于某档时识别出那一档，否则自定义', () => {
        expect(plan.itemsForTier('light')).toEqual(['history', 'agentSessions', 'settings']);
        expect(plan.itemsForTier('standard')).toEqual(['history', 'agentSessions', 'settings', 'uploads', 'agentExtras', 'workdir']);
        expect(plan.itemsForTier('full')).toHaveLength(plan.ITEMS.length);
        expect(plan.matchTier(plan.itemsForTier('standard'))).toBe('standard');
        expect(plan.matchTier([...plan.itemsForTier('standard'), 'snapshots'])).toBe('custom');
        expect(plan.normalizeItems(undefined, 'light')).toEqual(plan.itemsForTier('light'));
        expect(plan.normalizeItems(['workdir', 'history'])).toEqual(['history', 'workdir']);
        expect(() => plan.normalizeItems(['nope'])).toThrow(/未知/);
        expect(() => plan.normalizeItems(undefined, 'nope')).toThrow(/档位/);
    });

    test('永远不导出缓存、临时目录、运行时生成的文件和挂载点', () => {
        for (const p of ['/tmp/x', '/root/.codex/.tmp/big', '/root/.cache/pip', '/root/.npm/_cacache/x', '/run/manyoyo/env', '/proc/1', '/etc/hosts', '/work/node_modules/.cache/a', '/var/lib/apt/lists/x']) {
            expect(plan.classifyLayerPath(p)).toBeNull();
        }
        expect(plan.classifyLayerPath('/workspace/a', ['/workspace'])).toBeNull();
        expect(plan.classifyLayerPath('/workspace', ['/workspace'])).toBeNull();
        expect(plan.classifyLayerPath('/workspace2/a', ['/workspace'])).toBe('systemLayer');
        expect(plan.classifyLayerPath('/root/../etc/passwd')).toBe('systemLayer');
        expect(plan.classifyLayerPath('relative')).toBeNull();
    });

    test('/tmp 整体不导出，但 /tmp/.playwright-cli（Agent 浏览器的截图、二维码）放行，归到“Agent 其余改动”', () => {
        expect(plan.classifyLayerPath('/tmp/.playwright-cli/qrcode.jpg')).toBe('agentExtras');
        expect(plan.classifyLayerPath('/tmp/.playwright-cli')).toBe('agentExtras');
        expect(plan.classifyLayerPath('/tmp/other/x')).toBeNull();
        expect(plan.classifyLayerPath('/tmp/.playwright-cli/x', ['/tmp'])).toBeNull();
        expect(plan.layerScopes(new Set(['agentExtras']), [])).toContain('/tmp/.playwright-cli');
    });

    test('分类：会话记录 / Agent 其余改动 / 系统层', () => {
        expect(plan.classifyLayerPath('/root/.claude/projects/-w/abc.jsonl')).toBe('agentSessions');
        expect(plan.classifyLayerPath('/root/.claude.json')).toBe('agentSessions');
        expect(plan.classifyLayerPath('/root/.codex/sessions/2026/a.jsonl')).toBe('agentSessions');
        expect(plan.classifyLayerPath('/root/.codex/state_5.sqlite-wal')).toBe('agentSessions');
        expect(plan.classifyLayerPath('/root/.codex/skills/x/SKILL.md')).toBe('agentExtras');
        expect(plan.classifyLayerPath('/root/.claude/settings.json')).toBe('agentExtras');
        expect(plan.classifyLayerPath('/usr/local/bin/mytool')).toBe('systemLayer');
    });

    test('cp 范围：只开会话记录时不碰其它目录；开系统层时按 diff 取前两级目录并去重', () => {
        const only = plan.layerScopes(new Set(['agentSessions']), []);
        expect(only).toContain('/root/.claude/projects');
        expect(only).not.toContain('/root/.claude');
        const scopes = plan.layerScopes(new Set(['systemLayer']), ['/usr/local/bin/mytool', '/usr/local/lib/x', '/tmp/a', '/var/lib/dpkg/status']);
        expect(scopes).toEqual(['/usr/local', '/var/lib']);
        expect(plan.layerScopes(new Set(['agentExtras']), [])).toContain('/root/.codex');
    });

    test('解析 diff 输出', () => {
        const { added, deleted } = plan.parseDiff('A /usr/local/bin/mytool\nC /root\nD /etc/old\nbad line\nA /a/../b\n');
        expect([...added.entries()]).toEqual([['/usr/local/bin/mytool', 'A'], ['/root', 'C'], ['/b', 'A']]);
        expect(deleted).toEqual(['/etc/old']);
    });

    test('密钥变量名识别', () => {
        for (const name of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MY_SECRET', 'DB_PASSWORD', 'CREDENTIAL_X']) expect(plan.isSecretName(name)).toBe(true);
        expect(plan.isSecretName('ANTHROPIC_MODEL')).toBe(false);
    });
});
