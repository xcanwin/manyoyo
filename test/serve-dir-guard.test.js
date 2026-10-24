const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveDirOf, listServeDir, findLeaked } = require('./support/serve-dir-guard');

describe('serve 目录守卫', () => {
    test('只报告新增的文件名；目录不存在当作空', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-guard-'));
        const dir = serveDirOf(home);
        expect(listServeDir(dir)).toEqual([]);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'app.json'), '{}');
        const before = listServeDir(dir);
        expect(findLeaked(before, listServeDir(dir))).toEqual([]);
        fs.writeFileSync(path.join(dir, 'auth-sessions-127.0.0.1_1.json'), '{}');
        fs.mkdirSync(path.join(dir, 'login-tokens'));
        expect(findLeaked(before, listServeDir(dir))).toEqual(['auth-sessions-127.0.0.1_1.json', 'login-tokens']);
        fs.rmSync(home, { recursive: true, force: true });
    });
});
