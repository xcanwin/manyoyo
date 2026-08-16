'use strict';

const fs = require('fs');
const path = require('path');

const dockerignorePath = path.resolve(__dirname, '../.dockerignore');

describe('.dockerignore', () => {
    test('存在于仓库根目录', () => {
        expect(fs.existsSync(dockerignorePath)).toBe(true);
    });

    test('排除本机个人/构建产物目录，避免被纳入构建上下文', () => {
        const content = fs.readFileSync(dockerignorePath, 'utf-8');
        ['.git/', 'node_modules/', 'temp/', '.env', 'coverage/', 'nohup.out'].forEach(entry => {
            expect(content).toContain(entry);
        });
    });
});
