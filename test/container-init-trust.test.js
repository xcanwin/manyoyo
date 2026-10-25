'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INIT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'container-init.sh'), 'utf8');
const FUNC = (INIT.match(/# BEGIN trust_workdir\n([\s\S]*?)\n# END trust_workdir/) || [])[1];

function runTrust(home, workdir, env = {}) {
    return spawnSync('/bin/bash', ['-c', `${FUNC}\ncd "$WORKDIR" && trust_workdir; echo "rc=$?"`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, WORKDIR: workdir, ...env }
    });
}

describe('init.sh 的 trust_workdir', () => {
    let home;
    let work;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-home-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-work-'));
        fs.mkdirSync(path.join(home, '.codex'));
    });
    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });
    const claudeFile = () => path.join(home, '.claude.json');
    const codexFile = () => path.join(home, '.codex', 'config.toml');
    const real = () => fs.realpathSync(work);

    test('函数存在', () => {
        expect(FUNC).toContain('trust_workdir()');
    });

    test('首次写入 claude 与 codex 的信任记录，保留已有内容', () => {
        fs.writeFileSync(claudeFile(), JSON.stringify({ theme: 'dark', projects: { '/other': { x: 1 } } }));
        fs.writeFileSync(codexFile(), 'model = "a"\n');
        const result = runTrust(home, work);
        expect(result.stdout).toContain('rc=0');
        const data = JSON.parse(fs.readFileSync(claudeFile(), 'utf8'));
        expect(data.theme).toBe('dark');
        expect(data.projects['/other']).toEqual({ x: 1 });
        expect(data.projects[real()].hasTrustDialogAccepted).toBe(true);
        const toml = fs.readFileSync(codexFile(), 'utf8');
        expect(toml).toContain('model = "a"');
        expect(toml).toContain(`[projects."${real()}"]\ntrust_level = "trusted"`);
    });

    test('重复执行幂等，文件不再变化', () => {
        fs.writeFileSync(claudeFile(), '{}');
        fs.writeFileSync(codexFile(), '');
        runTrust(home, work);
        const claude1 = fs.readFileSync(claudeFile(), 'utf8');
        const codex1 = fs.readFileSync(codexFile(), 'utf8');
        runTrust(home, work);
        expect(fs.readFileSync(claudeFile(), 'utf8')).toBe(claude1);
        expect(fs.readFileSync(codexFile(), 'utf8')).toBe(codex1);
    });

    test('~/.claude.json 损坏时不动它，也不报错', () => {
        fs.writeFileSync(claudeFile(), '{not json');
        const result = runTrust(home, work);
        expect(result.stdout).toContain('rc=0');
        expect(fs.readFileSync(claudeFile(), 'utf8')).toBe('{not json');
    });

    test('文件都不存在时什么都不创建', () => {
        fs.rmdirSync(path.join(home, '.codex'));
        const result = runTrust(home, work);
        expect(result.stdout).toContain('rc=0');
        expect(fs.readdirSync(home)).toEqual([]);
    });

    test('路径含引号时 codex 不写', () => {
        const odd = path.join(work, 'a"b');
        fs.mkdirSync(odd);
        fs.writeFileSync(codexFile(), '');
        const result = runTrust(home, odd);
        expect(result.stdout).toContain('rc=0');
        expect(fs.readFileSync(codexFile(), 'utf8')).toBe('');
    });

    test('没有 node 时不报错，codex 仍写入', () => {
        fs.writeFileSync(claudeFile(), '{}');
        fs.writeFileSync(codexFile(), '');
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-bin-'));
        try {
            for (const name of ['grep', 'printf', 'cat']) {
                const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
                if (found) fs.symlinkSync(found, path.join(bin, name));
            }
            const result = runTrust(home, work, { PATH: bin });
            expect(result.stdout).toContain('rc=0');
            expect(fs.readFileSync(claudeFile(), 'utf8')).toBe('{}');
            expect(fs.readFileSync(codexFile(), 'utf8')).toContain('trust_level = "trusted"');
        } finally {
            fs.rmSync(bin, { recursive: true, force: true });
        }
    });

    test('init.sh 在后台调用它，且在主循环之前', () => {
        expect(INIT).toMatch(/\(trust_workdir\) >\/dev\/null 2>&1 &/);
        expect(INIT.indexOf('(trust_workdir)')).toBeLessThan(INIT.indexOf('while :; do'));
    });
});
