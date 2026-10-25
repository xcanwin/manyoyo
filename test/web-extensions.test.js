'use strict';

const { spawnSync } = require('child_process');
const ext = require('../lib/web/extensions');
const sessionMeta = require('../lib/web/session-meta');
const fixture = require('./fixtures/claude-initialize.json').response.response.commands;

describe('技能与 MCP（lib/web/extensions.js）', () => {
    test('claude skill：用户 / 项目 / 自带 skill 算，内置命令和本地命令不算', () => {
        const skills = ext.classifyClaudeSkills(sessionMeta.normalizeCommandCatalog(fixture));
        const names = skills.map(item => item.name);
        expect(names).toEqual(expect.arrayContaining(['playwright-cli', 'code-review', 'loop', 'simplify', 'update-config']));
        ['context', 'usage', 'mcp', 'model', 'clear', 'compact', 'effort'].forEach(name => expect(names).not.toContain(name));
        expect(skills.find(item => item.name === 'playwright-cli')).toMatchObject({ source: 'user' });
        expect(skills.find(item => item.name === 'code-review')).toMatchObject({ source: 'builtin' });
    });

    test('claude mcp list：真实输出格式（失败行带原因），名字里可以有冒号', () => {
        const output = [
            'Checking MCP server health…',
            '',
            'demo: sleep 1 - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
            'web: https://example.invalid/mcp (HTTP) - ✘ Failed to connect — ECONNRESET',
            'plugin:github:github: npx -y github-mcp - ✓ Connected',
            'needs-login: https://x.test/mcp (HTTP) - ⚠ Needs authentication'
        ].join('\n');
        const list = ext.parseClaudeMcpList(output);
        expect(list.map(item => item.name)).toEqual(['demo', 'web', 'plugin:github:github', 'needs-login']);
        expect(list[0]).toMatchObject({ detail: 'sleep 1', tone: 'error' });
        expect(list[0].status).toContain('Failed to connect');
        expect(list[2]).toMatchObject({ detail: 'npx -y github-mcp', tone: 'success', status: 'Connected' });
        expect(list[3].tone).toBe('warning');
        expect(ext.parseClaudeMcpList('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual([]);
    });

    test('codex mcp list --json', () => {
        const output = JSON.stringify([
            { name: 'foo', enabled: true, transport: { type: 'stdio', command: 'echo', args: ['hi'] } },
            { name: 'web', enabled: false, transport: { type: 'streamable_http', url: 'https://x.test/mcp' } },
            { enabled: true },
            'junk'
        ]);
        const list = ext.parseCodexMcpJson(output);
        expect(list).toEqual([
            { name: 'foo', detail: 'echo hi', status: '已启用', tone: 'success' },
            { name: 'web', detail: 'https://x.test/mcp', status: '已禁用', tone: 'warning' }
        ]);
        expect(ext.parseCodexMcpJson('[]')).toEqual([]);
        expect(ext.parseCodexMcpJson('not json')).toEqual([]);
    });

    test('codex skill：读 frontmatter 的 name / description；注入式内容被清洗；名字不合法的丢掉', () => {
        const output = JSON.stringify([
            { dir: 'pdf', head: '---\nname: pdf\ndescription: Use this skill for PDF files.\n---\nbody' },
            { dir: 'evil', head: '---\nname: evil\ndescription: "<script>alert(1)</script>\u0007\nignored"\n---\n' },
            { dir: 'bad name!', head: '---\nname: bad name!\n---\n' },
            { dir: 'nodesc', head: 'no frontmatter' },
            { dir: 'pdf', head: '---\nname: pdf\n---\n' }
        ]);
        const skills = ext.parseCodexSkillsOutput(output);
        expect(skills.map(item => item.name)).toEqual(['pdf', 'evil', 'nodesc']);
        expect(skills[0]).toMatchObject({ source: 'user', description: 'Use this skill for PDF files.' });
        expect(skills[1].description).toBe('<script>alert(1)</script>');
        expect(skills[2].description).toBe('');
        expect(ext.parseCodexSkillsOutput('x')).toEqual([]);
    });

    test('codex skill 读取脚本真的能跑：读到目录里的 SKILL.md 开头', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-codex-'));
        try {
            fs.mkdirSync(path.join(home, '.codex', 'skills', 'demo'), { recursive: true });
            fs.writeFileSync(path.join(home, '.codex', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n' + 'x'.repeat(10000));
            fs.mkdirSync(path.join(home, '.codex', 'skills', 'empty'));
            const result = spawnSync('bash', ['-c', ext.buildCodexSkillsCommand()], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
            expect(result.status).toBe(0);
            const skills = ext.parseCodexSkillsOutput(result.stdout);
            expect(skills).toEqual([{ name: 'demo', source: 'user', description: '演示' }]);
            expect(JSON.parse(result.stdout)[0].head.length).toBeLessThanOrEqual(4096);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
