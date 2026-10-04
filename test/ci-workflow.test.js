'use strict';

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');

describe('ci workflow', () => {
    test('runs on branch pushes (not main) and pull requests, read-only, no secrets', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\njobs:'));
        expect(onBlock).toMatch(/push:\s*\n\s+branches-ignore:\s*\n\s+- main/);
        expect(onBlock).toContain('pull_request:');
        expect(text).toMatch(/permissions:\s*\n\s+contents: read/);
        expect(text).not.toMatch(/secrets\./);
    });

    test('runs the same checks as the local preflight, in order, plus the frontend typecheck', () => {
        const order = ['npm ci --include=optional', 'npm run build:web', '- run: npm test\n', 'npm run docs:check', 'npm run lint:sh', 'npm run typecheck'].map(cmd => text.indexOf(cmd));
        order.forEach(index => expect(index).toBeGreaterThan(-1));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(text).toContain('working-directory: frontend');
        expect(text).not.toMatch(/npm run lint(?!:sh)/);
    });

    test('cancels superseded runs of the same ref', () => {
        expect(text).toContain('cancel-in-progress: true');
    });
});
