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
        expect(plan.layerScopes(new Set(['agentExtras']), new Map([['/tmp/.playwright-cli', 'A'], ['/tmp/.playwright-cli/shot.png', 'A']]))).toEqual(['/tmp/.playwright-cli']);
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

    test('cp 范围：按内容项只取对应分类里真正改动的路径；没有改动的 Agent 目录（镜像自带的 .claude / .codex）一个字节都不读', () => {
        const added = new Map([
            ['/root/.claude', 'C'], ['/root/.claude/projects', 'A'], ['/root/.claude/projects/p', 'A'], ['/root/.claude/projects/p/a.jsonl', 'A'], ['/root/.claude/settings.json', 'C'],
            ['/root/.claude.json', 'C'], ['/root/.codex/skills/x.md', 'A'], ['/usr/local/bin/mytool', 'A']
        ]);
        expect(plan.layerScopes(new Set(['agentSessions']), added)).toEqual(['/root/.claude.json', '/root/.claude/projects']);
        expect(plan.layerScopes(new Set(['agentExtras']), added)).toEqual(['/root/.claude/settings.json', '/root/.codex/skills/x.md']);
        expect(plan.layerScopes(new Set(['agentSessions', 'agentExtras', 'systemLayer']), added)).toEqual(['/root/.claude.json', '/root/.claude/projects', '/root/.claude/settings.json', '/root/.codex/skills/x.md', '/usr/local/bin/mytool']);
        expect(plan.layerScopes(new Set(['agentSessions']), new Map())).toEqual([]);
        // 挂载点下的、临时目录不取
        expect(plan.layerScopes(new Set(['systemLayer']), new Map([['/workspace/x', 'A'], ['/tmp/a', 'A'], ['/opt/y', 'A']]), [], { mounts: ['/workspace'] })).toEqual(['/opt/y']);
    });

    test('系统层 cp 范围只取真正改动的路径：A 的最上层取整棵、没有下级改动的 C（被改的文件）取它自己，被牵连的父目录和被祖先覆盖的不取', () => {
        const added = new Map([
            ['/usr', 'C'], ['/usr/lib', 'C'], ['/usr/lib/qa-marker', 'C'],
            ['/usr/local', 'C'], ['/usr/local/bin', 'C'], ['/usr/local/bin/mytool', 'A'],
            ['/opt/newdir', 'A'], ['/opt/newdir/x', 'A'], ['/opt/newdir/sub', 'A'], ['/opt/newdir/sub/y', 'A'],
            ['/tmp/a', 'A'], ['/var/lib/dpkg/status', 'C']
        ]);
        const scopes = plan.layerScopes(new Set(['systemLayer']), added, ['/etc/old']);
        expect(scopes).toEqual(['/opt/newdir', '/usr/lib/qa-marker', '/usr/local/bin/mytool', '/var/lib/dpkg/status']);
    });

    test('系统层 cp 范围：只有删除的目录不取；同一个目录下单独要取的太多时合并成取这个目录', () => {
        expect(plan.layerScopes(new Set(['systemLayer']), new Map([['/etc', 'C']]), ['/etc/old.conf'])).toEqual([]);
        const added = new Map();
        for (let i = 0; i < 5; i += 1) added.set(`/opt/many/f${i}`, 'A');
        expect(plan.layerScopes(new Set(['systemLayer']), added, [], { mergeThreshold: 3 })).toEqual(['/opt/many']);
        expect(plan.layerScopes(new Set(['systemLayer']), added, [], { mergeThreshold: 10 })).toHaveLength(5);
    });

    test('cp 范围总数太多时整体往上提一级（每次 cp 有固定开销），最浅停在三级目录，不会提到 /usr/lib 这种大目录', () => {
        const added = new Map();
        for (let a = 0; a < 6; a += 1) for (let b = 0; b < 6; b += 1) for (let c = 0; c < 2; c += 1) added.set(`/opt/pkg${a}/sub${b}/leaf${c}/file`, 'A');
        const raised = plan.layerScopes(new Set(['systemLayer']), added, [], { maxScopes: 10, mergeThreshold: 100 });
        expect(raised).toHaveLength(36);
        expect(raised.every(scope => scope.split('/').filter(Boolean).length === 3)).toBe(true);
        expect(plan.layerScopes(new Set(['systemLayer']), added, [], { maxScopes: 1000, mergeThreshold: 100 })).toHaveLength(72);
    });

    test('被牵连的父目录不取，即使它的下级改动属于别的分类（没勾选 Agent 其余改动时 /root 也只是父目录）', () => {
        const added = new Map([['/root', 'C'], ['/usr/lib/qa-marker', 'C']]);
        // diff 里还有 C /root/.codex（agentExtras，没勾选所以不在 added 里），它的上一级 /root 在 parents 里：/root 不是“被改过的文件”
        expect(plan.layerScopes(new Set(['systemLayer']), added, [], { parents: new Set(['/root', '/root/.codex']) })).toEqual(['/usr/lib/qa-marker']);
        // 没有 parents 信息时才会把它当成叶子（所以导出端必须传）
        expect(plan.layerScopes(new Set(['systemLayer']), added, [])).toEqual(['/root', '/usr/lib/qa-marker']);
    });

    test('解析 diff 输出', () => {
        const { added, deleted } = plan.parseDiff('A /usr/local/bin/mytool\nC /root\nD /etc/old\nbad line\nA /a/../b\n');
        expect([...added.entries()]).toEqual([['/usr/local/bin/mytool', 'A'], ['/root', 'C'], ['/b', 'A']]);
        expect(deleted).toEqual(['/etc/old']);
    });

    test('密钥变量名识别：含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL 以及 PASSWD / PRIVATE / COOKIE / SESSION，整词的 PWD / PASS / PAT', () => {
        for (const name of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MY_SECRET', 'DB_PASSWORD', 'CREDENTIAL_X', 'MY_PASSWD', 'GH_PAT', 'PAT', 'DB_PASS', 'PASS', 'PWD', 'ROOT_PWD', 'PRIVATE_THING', 'AUTH_COOKIE', 'SESSION_ID']) expect(plan.isSecretName(name)).toBe(true);
        for (const name of ['ANTHROPIC_MODEL', 'PATH', 'PASSENGER_COUNT', 'COMPATIBLE', 'WORKDIR', 'OPENAI_BASE_URL']) expect(plan.isSecretName(name)).toBe(false);
    });

    test('凭据文件清单：登录凭据整份跳过，.ssh 里公钥 / known_hosts / config 例外', () => {
        for (const file of ['/root/.claude/.credentials.json', '/root/.codex/auth.json', '/root/.npmrc', '/root/.git-credentials', '/root/.netrc', '/root/.docker/config.json', '/root/.pypirc', '/root/.aws/credentials', '/root/.kube/config', '/root/.config/gh/hosts.yml', '/root/.ssh/id_ed25519', '/root/.ssh/authorized_keys']) {
            expect(plan.isCredentialFile(file)).toBe(true);
        }
        for (const file of ['/root/.ssh/id_ed25519.pub', '/root/.ssh/known_hosts', '/root/.ssh/config', '/root/.claude/settings.json', '/root/work/.npmrc']) expect(plan.isCredentialFile(file)).toBe(false);
    });

    test('命令文本里的 NAME=值：新增的密钥词也清空，PATH= 不动；URL 里的密码清掉', () => {
        expect(plan.redactCommandText('GH_PAT=abc MY_PASSWD="x y" PATH=/usr/bin DB=postgres://u:pw@h/db claude')).toBe('GH_PAT= MY_PASSWD= PATH=/usr/bin DB=postgres://u@h/db claude');
    });
});
