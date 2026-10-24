'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../lib/container-state');
const { findUsingContainers, rewriteEnvText, applyToContainers } = require('../lib/model-service-containers');

describe('rewriteEnvText', () => {
    test('只改指定变量：整行替换、缺的追加、要删的删掉，其余行和注释原样保留', () => {
        const text = '# 我的注释\nFOO=1\nANTHROPIC_AUTH_TOKEN=old\nANTHROPIC_BASE_URL=https://old.test\n\nBAR=2\n';
        const out = rewriteEnvText(text, { set: { ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_MODEL: 'm1' }, remove: ['ANTHROPIC_BASE_URL'] });
        expect(out).toBe('# 我的注释\nFOO=1\nANTHROPIC_AUTH_TOKEN=new\n\nBAR=2\nANTHROPIC_MODEL=m1\n');
    });

    test('空文本、没有结尾换行也行；带空格的值会加引号', () => {
        expect(rewriteEnvText('', { set: { A: '1' } })).toBe('A=1\n');
        expect(rewriteEnvText('A=0', { set: { A: ' x ' } })).toBe('A=" x "\n');
    });
});

describe('容器里的 env 同步', () => {
    let home;
    const make = (name, text) => {
        const created = state.createState({ homeDir: home, envLines: [], meta: { name } });
        state.writeEnv(home, created.id, text);
        return { name, id: created.id };
    };
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-containers-')); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('按旧 Key 找出还在用的容器，只更新它们，别的容器不动', () => {
        const a = make('a', 'ANTHROPIC_AUTH_TOKEN=old-key\nX=1\n');
        const b = make('b', 'ANTHROPIC_AUTH_TOKEN=other-key\n');
        const c = make('c', 'X=1\n');
        const using = findUsingContainers({ homeDir: home, containers: [a, b, c], keyEnv: 'ANTHROPIC_AUTH_TOKEN', keyValue: 'old-key' });
        expect(using.map(item => item.name)).toEqual(['a']);
        expect(applyToContainers({ homeDir: home, targets: using, set: { ANTHROPIC_AUTH_TOKEN: 'new-key' }, remove: [] })).toEqual(['a']);
        expect(state.readEnv(home, a.id).text).toBe('ANTHROPIC_AUTH_TOKEN=new-key\nX=1\n');
        expect(state.readEnv(home, b.id).text).toBe('ANTHROPIC_AUTH_TOKEN=other-key\n');
        expect(state.readEnv(home, c.id).text).toBe('X=1\n');
    });

    test('同一个 Key 用在别的地址上的容器不算（Claude 和 Codex、或两个模型共用 Key 时不误伤）', () => {
        const a = make('a', 'OPENAI_API_KEY=k1\nOPENAI_BASE_URL=https://api.deepseek.com\n');
        const b = make('b', 'OPENAI_API_KEY=k1\nOPENAI_BASE_URL=https://open.bigmodel.cn/api/v1\n');
        const c = make('c', 'OPENAI_API_KEY=k1\n');
        const using = findUsingContainers({ homeDir: home, containers: [a, b, c], keyEnv: 'OPENAI_API_KEY', keyValue: 'k1', baseUrlKey: 'OPENAI_BASE_URL', baseUrl: 'https://api.deepseek.com' });
        expect(using.map(item => item.name)).toEqual(['a']);
        // 服务没有地址（官方）就只看 Key
        expect(findUsingContainers({ homeDir: home, containers: [a, b, c], keyEnv: 'OPENAI_API_KEY', keyValue: 'k1', baseUrlKey: 'OPENAI_BASE_URL', baseUrl: '' })).toHaveLength(3);
    });

    test('某个容器写不进去只跳过它，不抛错', () => {
        const a = make('a', 'K=old\n');
        const broken = { name: 'broken', id: 'ffffffffffffffff' };
        expect(applyToContainers({ homeDir: home, targets: [broken, a], set: { K: 'new' }, remove: [] })).toEqual(['a']);
    });

    test('没有 Key 或没有状态目录的容器不算在用', () => {
        expect(findUsingContainers({ homeDir: home, containers: [{ name: 'x', id: '0123456789abcdef' }], keyEnv: 'K', keyValue: 'v' })).toEqual([]);
        expect(findUsingContainers({ homeDir: home, containers: [], keyEnv: 'K', keyValue: '' })).toEqual([]);
    });
});
