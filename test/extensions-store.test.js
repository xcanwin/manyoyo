'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/extensions-store');

describe('extensions-store：共享技能', () => {
    let home;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-store-'));
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('写入 / 列出 / 读取 / 删除；文件 0600、目录 0700；frontmatter 描述与目录名核对', () => {
        const saved = store.writeSkill(home, 'claude', 'demo', '---\nname: demo\ndescription: 演示技能\n---\n正文\n');
        expect(saved).toEqual(expect.objectContaining({ agent: 'claude', name: 'demo', description: '演示技能', nameMismatch: false }));
        const file = path.join(home, '.manyoyo', 'extensions', 'skills', 'claude', 'demo', 'SKILL.md');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777).toBe(0o700);

        store.writeSkill(home, 'common', 'shared', '---\nname: other\ndescription: 公共\n---\n');
        const list = store.listSkills(home);
        expect(list.map(item => `${item.agent}/${item.name}`).sort()).toEqual(['claude/demo', 'common/shared']);
        expect(list.find(item => item.name === 'shared').nameMismatch).toBe(true);

        expect(store.readSkill(home, 'claude', 'demo').content).toContain('正文');
        store.deleteSkill(home, 'claude', 'demo');
        expect(store.listSkills(home).some(item => item.name === 'demo')).toBe(false);
    });

    test('名字与大小校验：路径穿越 / 非法 agent / 空内容 / 超过 1 MB 都拒绝', () => {
        ['../x', 'a/b', '', 'a b', 'x'.repeat(65)].forEach(name => {
            expect(() => store.writeSkill(home, 'claude', name, 'x')).toThrow();
        });
        expect(() => store.writeSkill(home, 'other', 'ok', 'x')).toThrow();
        expect(() => store.writeSkill(home, 'claude', 'ok', '   ')).toThrow();
        expect(() => store.writeSkill(home, 'claude', 'big', `---\nname: big\n---\n${'x'.repeat(1024 * 1024)}`)).toThrow(/1 MB/);
        expect(() => store.deleteSkill(home, 'claude', '../../x')).toThrow();
    });
});

describe('extensions-store：共享 MCP', () => {
    let home;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-mcp-'));
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('新增 stdio：列表只给掩码，详情给 key + 末 4 位；文件 0600；KEEP 保留原值，空串清空，缺省删除', () => {
        const created = store.saveMcp(home, {
            name: 'echo',
            agents: ['claude', 'codex'],
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'echo-mcp'],
            env: [{ key: 'API_KEY', value: 'sk-test-12345678' }, { key: 'OTHER', value: 'abcdef' }]
        });
        expect(created.id).toMatch(/^[0-9a-f]{16}$/);
        const file = path.join(home, '.manyoyo', 'extensions', 'mcp.json');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(stored.servers[0].env).toEqual({ API_KEY: 'sk-test-12345678', OTHER: 'abcdef' });

        expect(store.listMcp(home)).toEqual([expect.objectContaining({ id: created.id, name: 'echo', agents: ['claude', 'codex'], transport: 'stdio', enabled: true })]);
        const detail = store.getMcp(home, created.id);
        expect(detail.env).toEqual([{ key: 'API_KEY', masked: '****5678' }, { key: 'OTHER', masked: '****cdef' }]);
        expect(JSON.stringify(detail)).not.toContain('12345678');

        const updated = store.saveMcp(home, {
            name: 'echo',
            agents: ['claude', 'codex'],
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'echo-mcp'],
            env: [{ key: 'API_KEY', value: store.KEEP }, { key: 'NEW', value: 'zzz' }]
        }, created.id);
        expect(updated.env).toEqual({ API_KEY: 'sk-test-12345678', NEW: 'zzz' });

        store.saveMcp(home, { name: 'echo', agents: ['claude'], transport: 'stdio', command: 'npx', env: [{ key: 'API_KEY', value: '' }] }, created.id);
        expect(store.getMcpInternal(home, created.id).env).toEqual({});
    });

    test('transport × agents 校验：SSE 只给 Claude；Codex 的 HTTP 不收 headers；URL 不能带 userinfo；同名拒绝', () => {
        expect(() => store.saveMcp(home, { name: 's', agents: ['codex'], transport: 'sse', url: 'https://a.example/mcp' })).toThrow(/SSE/);
        expect(() => store.saveMcp(home, { name: 'h', agents: ['codex'], transport: 'http', url: 'https://a.example/mcp', headers: [{ key: 'X-Key', value: 'v' }] })).toThrow(/headers/);
        expect(() => store.saveMcp(home, { name: 'u', agents: ['claude'], transport: 'http', url: 'https://user:pass@a.example/mcp' })).toThrow(/用户名密码/);
        expect(() => store.saveMcp(home, { name: 'bad name', agents: ['claude'], transport: 'stdio', command: 'x' })).toThrow();
        const a = store.saveMcp(home, { name: 'dup', agents: ['claude'], transport: 'stdio', command: 'x' });
        expect(() => store.saveMcp(home, { name: 'dup', agents: ['claude'], transport: 'stdio', command: 'y' })).toThrow(/已存在/);
        store.deleteMcp(home, a.id);
        expect(store.listMcp(home)).toEqual([]);
    });

    test('catalogHash 随技能内容与 MCP 密钥变化（只存哈希，state 里不出现明文）', () => {
        const before = store.catalogHash(home);
        store.writeSkill(home, 'common', 'demo', '---\nname: demo\n---\none\n');
        const withSkill = store.catalogHash(home);
        expect(withSkill).not.toBe(before);
        store.writeSkill(home, 'common', 'demo', '---\nname: demo\n---\ntwo\n');
        expect(store.catalogHash(home)).not.toBe(withSkill);
        const saved = store.saveMcp(home, { name: 'k', agents: ['claude'], transport: 'stdio', command: 'x', env: [{ key: 'K', value: 'one' }] });
        const keyOne = store.catalogHash(home);
        store.saveMcp(home, { name: 'k', agents: ['claude'], transport: 'stdio', command: 'x', env: [{ key: 'K', value: 'two' }] }, saved.id);
        expect(store.catalogHash(home)).not.toBe(keyOne);
        expect(store.catalogHash(home)).toMatch(/^[0-9a-f]{32}$/);
    });

    test('enabledFor 只给启用的、适用该 Agent 的条目；agentSkills 合并 common 与对应目录', () => {
        store.saveMcp(home, { name: 'a', agents: ['claude'], transport: 'stdio', command: 'x' });
        store.saveMcp(home, { name: 'b', agents: ['codex'], transport: 'stdio', command: 'y', enabled: false });
        expect(store.enabledFor(home, 'claude').map(item => item.name)).toEqual(['a']);
        expect(store.enabledFor(home, 'codex')).toEqual([]);
        store.writeSkill(home, 'common', 'c1', 'x');
        store.writeSkill(home, 'claude', 'c2', 'x');
        store.writeSkill(home, 'codex', 'c3', 'x');
        expect(store.agentSkills(home, 'claude').sort()).toEqual(['c1', 'c2']);
        expect(store.agentSkills(home, 'codex').sort()).toEqual(['c1', 'c3']);
    });
});
