'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReport, tailLog, renderMarkdown, writeReport, loadJobs, fetchJobLog, generateReport } = require('../scripts/release/pipeline-report');

const job = (name, over = {}) => ({ id: Math.floor(Math.random() * 1e6), name, status: 'completed', conclusion: 'success', started_at: '2026-10-13T10:00:00Z', completed_at: '2026-10-13T10:01:30Z', html_url: `https://github.com/x/y/actions/runs/1/job/${name.length}`, ...over });

describe('pipeline report', () => {
    test('jobs of a reusable workflow are grouped under the caller job id, with start, duration and result per stage', () => {
        const report = buildReport({
            version: '8.7.0', sha: 'abc', runUrl: 'https://github.com/x/y/actions/runs/1',
            jobs: [
                job('prepare'),
                job('packages / build-macos (x64, macos-15-intel)', { started_at: '2026-10-13T10:02:00Z', completed_at: '2026-10-13T10:20:00Z' }),
                job('packages / build-linux (x64, ubuntu-24.04)', { started_at: '2026-10-13T10:02:00Z', completed_at: '2026-10-13T10:10:00Z' }),
                job('summary')
            ]
        });
        expect(report.stages.map(stage => stage.id)).toEqual(['prepare', 'packages']);
        const packages = report.stages[1];
        expect(packages).toMatchObject({ result: 'success', startedAt: '2026-10-13T10:02:00Z', durationSec: 1080 });
        expect(report).toMatchObject({ version: '8.7.0', sha: 'abc', result: 'success', runUrl: 'https://github.com/x/y/actions/runs/1' });
        // 汇总 job 自己不算阶段
        expect(report.stages.some(stage => stage.id === 'summary')).toBe(false);
    });

    test('matrix jobs of a top-level job are one stage (the matrix suffix is not part of the stage id)', () => {
        const report = buildReport({ version: 'v', sha: 's', runUrl: 'u', jobs: [job('smoke-macos (macos-15, arm64)'), job('smoke-macos (macos-15-intel, x64)', { conclusion: 'failure' }), job('packages / build-macos (x64, macos-15-intel)')] });
        expect(report.stages.map(stage => stage.id)).toEqual(['smoke-macos', 'packages']);
        expect(report.stages[0].result).toBe('failure');
        expect(report.failedJobs.map(item => item.stage)).toEqual(['smoke-macos']);
    });

    test('result precedence: failure > cancelled > skipped; one failed job fails its stage and the run', () => {
        const report = buildReport({
            version: '8.7.0', sha: 'abc', runUrl: 'u',
            jobs: [
                job('a'),
                job('b / x', { conclusion: 'failure' }), job('b / y', { conclusion: 'success' }),
                job('c', { conclusion: 'skipped', started_at: null, completed_at: null }),
                job('d', { conclusion: 'cancelled' })
            ]
        });
        const byId = Object.fromEntries(report.stages.map(stage => [stage.id, stage]));
        expect(byId.b.result).toBe('failure');
        expect(byId.c.result).toBe('skipped');
        expect(byId.c.durationSec).toBe(0);
        expect(byId.d.result).toBe('cancelled');
        expect(report.result).toBe('failure');
        expect(report.failedJobs.map(item => item.name)).toEqual(['b / x']);
    });

    test('skipped jobs report no start and zero duration even though the API gives them timestamps (completed may precede started)', () => {
        const report = buildReport({ version: 'v', sha: 's', runUrl: 'u', jobs: [job('a'), job('b', { conclusion: 'skipped', started_at: '2026-10-13T10:00:13Z', completed_at: '2026-10-13T10:00:12Z' })] });
        const skipped = report.stages.find(stage => stage.id === 'b');
        expect(skipped).toMatchObject({ result: 'skipped', startedAt: null, durationSec: 0 });
    });

    test('a running stage shows how long it has been running (the API gives a zero completion date for jobs still in progress)', () => {
        const now = Date.parse('2026-10-13T10:05:00Z');
        const report = buildReport({ version: 'v', sha: 's', runUrl: 'u', now, jobs: [job('a', { status: 'in_progress', conclusion: '', started_at: '2026-10-13T10:00:00Z', completed_at: '0001-01-01T00:00:00Z' })] });
        expect(report.stages[0]).toMatchObject({ result: 'running', durationSec: 300 });
    });

    test('an all-skipped / cancelled run is not reported as success', () => {
        expect(buildReport({ version: 'v', sha: 's', runUrl: 'u', jobs: [job('a', { conclusion: 'cancelled' })] }).result).toBe('cancelled');
    });

    test('tailLog keeps the last N lines, strips timestamps and terminal colors', () => {
        const raw = Array.from({ length: 300 }, (_, i) => `2026-10-13T10:00:${String(i % 60).padStart(2, '0')}.1234567Z \u001b[31mline ${i}\u001b[0m`).join('\n');
        const lines = tailLog(raw, 200).split('\n');
        expect(lines).toHaveLength(200);
        expect(lines[0]).toBe('line 100');
        expect(lines[199]).toBe('line 299');
        expect(tailLog('', 200)).toBe('');
    });

    test('tailLog ends at the failing step (##[error]) instead of the post-job cleanup noise that follows it', () => {
        const lines = [...Array.from({ length: 30 }, (_, i) => `2026-10-13T10:00:00.0000000Z step line ${i}`), '2026-10-13T10:01:00.0000000Z curl: (22) The requested URL returned error: 403', '2026-10-13T10:01:00.0000000Z ##[error]Process completed with exit code 22.', ...Array.from({ length: 80 }, (_, i) => `2026-10-13T10:01:01.0000000Z Post job cleanup ${i}`)];
        const tail = tailLog(lines.join('\n'), 200).split('\n');
        expect(tail[tail.length - 1]).toContain('##[error]Process completed with exit code 22.');
        expect(tail.some(line => line.includes('Post job cleanup'))).toBe(false);
        // 没有 ##[error] 时仍是整份日志的最后 N 行
        expect(tailLog(['a', 'b', 'c'].join('\n'), 2)).toBe('b\nc');
    });

    test('markdown table lists every stage with a link; writeReport writes summary json and one log per failed stage', () => {
        const report = buildReport({ version: '8.7.0', sha: 'abc', runUrl: 'https://r', jobs: [job('prepare'), job('packages / build', { id: 77, conclusion: 'failure' })] });
        const md = renderMarkdown(report);
        expect(md).toContain('| prepare | success |');
        expect(md).toContain('| packages | failure |');
        expect(md).toContain('https://r');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-report-'));
        try {
            const fetchLog = id => (id === 77 ? '2026-10-13T10:00:00.000Z boom\n' : '');
            writeReport({ report, outDir: out, fetchLog });
            const written = JSON.parse(fs.readFileSync(path.join(out, 'release-summary.json'), 'utf-8'));
            expect(written.stages.find(stage => stage.id === 'packages').logArtifact).toBe('failed-packages.log');
            expect(written.stages.find(stage => stage.id === 'prepare').logArtifact).toBeUndefined();
            expect(fs.readFileSync(path.join(out, 'failed-packages.log'), 'utf-8')).toContain('boom');
            expect(fs.existsSync(path.join(out, 'failed-prepare.log'))).toBe(false);
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });
});

describe('generateReport', () => {
    test('loads the jobs and the failed job logs of a finished run and writes summary + failed-<stage>.log', () => {
        const ghImpl = args => {
            if (args[1].includes('/jobs?')) return { status: 0, stdout: `${JSON.stringify({ id: 1, name: 'prepare', status: 'completed', conclusion: 'success', started_at: '2026-10-13T10:00:00Z', completed_at: '2026-10-13T10:00:05Z', html_url: 'u' })}\n${JSON.stringify({ id: 2, name: 'test / test', status: 'completed', conclusion: 'failure', started_at: '2026-10-13T10:00:00Z', completed_at: '2026-10-13T10:01:00Z', html_url: 'u2' })}\n` };
            return { status: 0, stdout: '2026-10-13T10:00:59.0000000Z boom\n2026-10-13T10:01:00.0000000Z ##[error]Process completed with exit code 1.\n' };
        };
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-gen-'));
        try {
            const report = generateReport({ ghImpl, repo: 'x/y', runId: 9, version: '8.7.0', sha: 'abc', outDir: out, sleep: () => {} });
            expect(report.result).toBe('failure');
            expect(fs.readFileSync(path.join(out, 'failed-test.log'), 'utf-8')).toContain('boom');
            expect(JSON.parse(fs.readFileSync(path.join(out, 'release-summary.json'), 'utf-8')).stages.find(stage => stage.id === 'test').logArtifact).toBe('failed-test.log');
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });
});

describe('generateReport with logs: false (the summary job inside the running pipeline)', () => {
    test('does not call the log API at all (it would return nothing) and writes no empty failed-<stage>.log; the failed stages are still listed', () => {
        const calls = [];
        const ghImpl = args => {
            calls.push(args[1]);
            return { status: 0, stdout: `${JSON.stringify({ id: 2, name: 'test / test', status: 'completed', conclusion: 'failure', started_at: '2026-10-13T10:00:00Z', completed_at: '2026-10-13T10:01:00Z', html_url: 'u2' })}\n` };
        };
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-gen2-'));
        try {
            const report = generateReport({ ghImpl, repo: 'x/y', runId: 9, outDir: out, logs: false });
            expect(calls.every(call => call.includes('/jobs?'))).toBe(true);
            expect(fs.existsSync(path.join(out, 'failed-test.log'))).toBe(false);
            expect(report.stages.find(stage => stage.id === 'test').result).toBe('failure');
            expect(report.stages.find(stage => stage.id === 'test').logArtifact).toBeUndefined();
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    });
});

describe('loadJobs', () => {
    test('parses the paginated jobs listing; a failing gh call is an error, not an empty report', () => {
        const ok = loadJobs(() => ({ status: 0, stdout: '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n' }), 'x/y', '1');
        expect(ok.map(item => item.id)).toEqual([1, 2]);
        expect(() => loadJobs(() => ({ status: 1, stdout: '' }), 'x/y', '1')).toThrow(/读不到/);
    });
});

describe('fetchJobLog', () => {
    test('a job log that is not ready yet (just finished: empty or 404) is retried; gives up with an empty string after the attempts', () => {
        const answers = [{ status: 1, stdout: '' }, { status: 0, stdout: '' }, { status: 0, stdout: 'real log\n' }];
        const waits = [];
        const log = fetchJobLog(() => answers.shift(), 'x/y', 7, { attempts: 5, sleepMs: 10, sleep: ms => waits.push(ms) });
        expect(log).toBe('real log\n');
        expect(waits).toEqual([10, 10]);
        const never = [];
        expect(fetchJobLog(() => ({ status: 1, stdout: '' }), 'x/y', 7, { attempts: 3, sleepMs: 1, sleep: ms => never.push(ms) })).toBe('');
        expect(never).toHaveLength(2);
    });
});
