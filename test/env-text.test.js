'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseEnvText, serializeEnvEntries, formatEnvValue } = require('../lib/env-text');

// 同一组语料也在 frontend/src/lib/container-manage.test.ts 里测前端的等价实现，容器内 env.sh 的 bash 实现在下面对照
const CORPUS = [
    ['CMT_A=1', { CMT_A: '1' }],
    ['CMT_SP=abc 123', { CMT_SP: 'abc 123' }],
    ['CMT_Q="abc 123"', { CMT_Q: 'abc 123' }],
    ["CMT_SQ='abc 123'", { CMT_SQ: 'abc 123' }],
    ['export CMT_E=1', { CMT_E: '1' }],
    ['export   CMT_E2 = two ', { CMT_E2: 'two' }],
    ['CMT_SPACES = a b ', { CMT_SPACES: 'a b' }],
    ['CMT_KEEP="  padded  "', { CMT_KEEP: '  padded  ' }],
    ['CMT_EMPTY=', { CMT_EMPTY: '' }],
    ['CMT_EQ=a=b=c', { CMT_EQ: 'a=b=c' }],
    ['CMT_ONEQ="abc', { CMT_ONEQ: '"abc' }],
    ['CMT_MIX="a\'', { CMT_MIX: '"a\'' }],
    ['CMT_NESTED=\'"x"\'', { CMT_NESTED: '"x"' }],
    ['CMT_URL=http://h:1/?a=1&b=2', { CMT_URL: 'http://h:1/?a=1&b=2' }],
    ['CMT_DOLLAR=$HOME `id` $(id)', { CMT_DOLLAR: '$HOME `id` $(id)' }],
    ['# comment', {}],
    ['   # indented comment', {}],
    ['', {}],
    ['1BAD=x', {}],
    ['BAD KEY=x', {}],
    ['noequals', {}],
    ['export=1', {}] // key 是 export：不是合法的“CMT_”前缀，仅用来确认不会把 export 当前缀吃掉后丢值
];

describe('env-text 语法', () => {
    test.each(CORPUS)('node 解析：%s', (line, expected) => {
        const parsed = parseEnvText(line);
        const got = Object.fromEntries(parsed.entries.map(e => [e.key, e.value]));
        const want = line === 'export=1' ? { export: '1' } : expected;
        expect(got).toEqual(want);
    });

    test('非法行单独报出并带行号', () => {
        const parsed = parseEnvText('A=1\n1BAD=x\n# c\nnoequals\n');
        expect(parsed.invalid.map(i => i.line)).toEqual([2, 4]);
    });

    test('serialize：只在首尾空白或首尾恰好一对引号时加引号，且能原样读回', () => {
        const values = ['abc', 'abc 123', ' lead', 'trail ', '"x"', "'x'", '"', 'it\'s', '', 'a=b', '"a\'', "'\"y\"'"];
        values.forEach(value => {
            const text = serializeEnvEntries([{ key: 'K', value }]);
            expect(parseEnvText(text).entries).toEqual([expect.objectContaining({ key: 'K', value })]);
        });
        expect(formatEnvValue('abc 123')).toBe('abc 123');
        expect(formatEnvValue(' x')).toBe('" x"');
        expect(formatEnvValue('"x"')).toBe("'\"x\"'");
    });

    test('容器内 env.sh 的 bash 实现与 node 解析同一语料同一结果', () => {
        const initSh = path.join(__dirname, '..', 'lib', 'container-env.sh');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-text-'));
        try {
            const file = path.join(dir, 'env');
            const lines = CORPUS.map(([line]) => line);
            fs.writeFileSync(file, `${lines.join('\n')}\n`);
            const script = `source <(sed -n '/^load_env()/,/^}/p' ${JSON.stringify(initSh)}); load_env ${JSON.stringify(file)}; env -0`;
            const out = spawnSync('bash', ['-c', script], { encoding: 'utf-8', env: { PATH: process.env.PATH } });
            expect(out.status).toBe(0);
            const bashEnv = Object.fromEntries(out.stdout.split('\0').filter(Boolean).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
            const nodeEnv = Object.fromEntries(parseEnvText(lines.join('\n')).entries.map(e => [e.key, e.value]));
            Object.entries(nodeEnv).forEach(([key, value]) => expect([key, bashEnv[key]]).toEqual([key, value]));
            // bash 里没有多出来的、node 认为非法的变量
            expect(Object.keys(bashEnv).filter(k => !(k in nodeEnv) && /^(CMT_|BAD|1BAD|noequals)/.test(k))).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('reload-env 按 managed < 环境变量文件 < 用户 env 的优先级重新加载', () => {
        const envSh = path.join(__dirname, '..', 'lib', 'container-env.sh');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-reload-'));
        try {
            const sys = path.join(dir, 'sys');
            const box = path.join(dir, 'box');
            fs.mkdirSync(sys);
            fs.mkdirSync(box);
            fs.writeFileSync(path.join(sys, 'managed.env'), 'A=managed\nB=managed\nC=managed\n');
            fs.writeFileSync(path.join(sys, 'files.env'), 'B=files\nC=files\n');
            fs.writeFileSync(path.join(box, 'env'), 'C=\"user\"\n');
            const script = `source ${JSON.stringify(envSh)}; export C=old; reload-env; echo "$A $B $C"`;
            const out = spawnSync('bash', ['-c', script], { encoding: 'utf-8', env: { PATH: process.env.PATH, MANYOYO_SYS_DIR: sys, MANYOYO_BOX_DIR: box } });
            expect(out.stdout.trim()).toBe('managed files user');
            // 文件不存在也不报错
            const none = spawnSync('bash', ['-c', `source ${JSON.stringify(envSh)}; reload-env; echo ok`], { encoding: 'utf-8', env: { PATH: process.env.PATH, MANYOYO_SYS_DIR: path.join(dir, 'x'), MANYOYO_BOX_DIR: path.join(dir, 'y') } });
            expect(none.stdout.trim()).toBe('ok');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
