'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobRegistry, gateRequest, containerOfPath, JobCancelled } = require('../lib/web/container-jobs');

describe('lib/web/container-jobs', () => {
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-jobs-')); });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    test('路径归到容器：会话键 容器~agent、容器管理接口、与容器无关的接口', () => {
        expect(containerOfPath('/api/sessions/box1~agent-2/agent/stream')).toEqual({ container: 'box1', tail: '/agent/stream' });
        expect(containerOfPath('/api/containers/box1/env')).toEqual({ container: 'box1', tail: '/env' });
        expect(containerOfPath('/api/sessions')).toBeNull();
        expect(containerOfPath('/api/containers/orphans')).toBeNull();
        expect(containerOfPath('/api/system/update')).toBeNull();
    });

    test('闸门：任务期间写接口、对话、文件、终端、删除、克隆都是 409；读消息与详情、其它容器放行；结束后放行', () => {
        const registry = createJobRegistry({ homeDir: home });
        const job = registry.create({ type: 'export', containers: ['box1'] });
        const cases = [
            ['POST', '/api/sessions/box1/agent/stream'],
            ['POST', '/api/sessions/box1~agent-2/agent/stream'],
            ['POST', '/api/sessions/box1/fs/write'],
            ['GET', '/api/sessions/box1/fs/read'],
            ['GET', '/api/sessions/box1/terminal'],
            ['POST', '/api/sessions/box1/remove'],
            ['POST', '/api/sessions/box1/clone'],
            ['POST', '/api/sessions/box1/container/stop'],
            ['PUT', '/api/containers/box1/env'],
            ['POST', '/api/containers/box1/autostart']
        ];
        for (const [method, p] of cases) {
            const verdict = gateRequest(registry, method, p);
            expect(verdict && verdict.status).toBe(409);
            expect(verdict.body).toMatchObject({ busy: 'export', jobId: job.id });
        }
        expect(gateRequest(registry, 'GET', '/api/sessions/box1/messages')).toBeNull();
        expect(gateRequest(registry, 'GET', '/api/sessions/box1~agent-2/detail')).toBeNull();
        expect(gateRequest(registry, 'POST', '/api/sessions/box1/messages')).not.toBeNull();
        expect(gateRequest(registry, 'POST', '/api/sessions/other/agent/stream')).toBeNull();
        expect(gateRequest(registry, 'GET', '/api/sessions')).toBeNull();
        job.finish('done');
        expect(gateRequest(registry, 'POST', '/api/sessions/box1/agent/stream')).toBeNull();
    });

    test('取消：check 抛 JobCancelled', () => {
        const registry = createJobRegistry({ homeDir: home });
        const job = registry.create({ type: 'import', containers: ['x'] });
        expect(() => job.check()).not.toThrow();
        expect(registry.cancel(job.id)).toBe(true);
        expect(() => job.check()).toThrow(JobCancelled);
    });

    test('落盘 → 重启恢复：只恢复/撤销 manyoyo.id 对得上的，删除记录在案的目录和 .part，任务标成已中断', () => {
        const registry = createJobRegistry({ homeDir: home });
        const exportJob = registry.create({ type: 'export', containers: ['paused-ok', 'paused-reused'] });
        const part = path.join(home, 'x.part');
        fs.writeFileSync(part, 'partial');
        exportJob.update({ partFile: part });
        exportJob.addPaused('paused-ok', 'aaaaaaaaaaaaaaaa');
        exportJob.addPaused('paused-reused', 'bbbbbbbbbbbbbbbb');
        const importJob = registry.create({ type: 'import', containers: ['new-ok', 'new-reused'] });
        const tmpDir = path.join(home, 'import-tmp');
        const historyFile = path.join(home, 'new-ok.json');
        fs.mkdirSync(tmpDir);
        fs.writeFileSync(historyFile, '{}');
        importJob.addCreated('containers', { name: 'new-ok', id: 'cccccccccccccccc' });
        importJob.addCreated('containers', { name: 'new-reused', id: 'dddddddddddddddd' });
        importJob.addCreated('dirs', tmpDir);
        importJob.addCreated('historyFiles', historyFile);
        expect(fs.readdirSync(path.join(home, '.manyoyo', 'jobs')).length).toBe(2);

        // 新进程：全新的注册表
        const after = createJobRegistry({ homeDir: home });
        const unpaused = [];
        const removed = [];
        const ids = { 'paused-ok': 'aaaaaaaaaaaaaaaa', 'paused-reused': 'ffffffffffffffff', 'new-ok': 'cccccccccccccccc', 'new-reused': 'eeeeeeeeeeeeeeee' };
        const reports = after.recover({
            containerIdOf: name => ids[name] || '',
            isPaused: () => true,
            unpause: name => unpaused.push(name),
            removeContainer: name => removed.push(name),
            removePath: p => fs.rmSync(p, { recursive: true, force: true })
        });
        expect(unpaused).toEqual(['paused-ok']);
        expect(removed).toEqual(['new-ok']);
        expect(fs.existsSync(part)).toBe(false);
        expect(fs.existsSync(tmpDir)).toBe(false);
        expect(fs.existsSync(historyFile)).toBe(false);
        expect(reports).toHaveLength(2);
        expect(after.list().map(job => job.status)).toEqual(['interrupted', 'interrupted']);
        expect(fs.readdirSync(path.join(home, '.manyoyo', 'jobs'))).toEqual([]);
        expect(after.busyFor('paused-ok')).toBeNull();
    });

    test('同一个 HOME 上另一个还活着的 serve 进程的任务不会被当成崩溃残留；失败的恢复动作保留记录等下次再试', () => {
        const dir = path.join(home, '.manyoyo', 'jobs');
        fs.mkdirSync(dir, { recursive: true });
        const mk = (id, pid) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, type: 'export', pid, containers: ['x'], paused: [{ name: 'x', id: 'aaaaaaaaaaaaaaaa', how: 'pause' }], created: { containers: [], dirs: [], historyFiles: [] } }));
        mk('1111111111111111', process.ppid); // 另一个活着的进程
        mk('2222222222222222', process.pid); // 同进程 = 上一代 registry 的残留
        const unpaused = [];
        const reports = createJobRegistry({ homeDir: home }).recover({
            containerIdOf: () => 'aaaaaaaaaaaaaaaa', isPaused: () => true, unpause: n => { unpaused.push(n); throw new Error('运行时还没好'); }, removeContainer() {}, removePath() {}
        });
        expect(unpaused).toEqual(['x']);
        expect(reports.map(r => r.id)).toEqual(['2222222222222222']);
        expect(reports[0].failed).toEqual(['x']);
        // 活着的进程的记录和失败的记录都还在
        expect(fs.readdirSync(dir).sort()).toEqual(['1111111111111111.json', '2222222222222222.json']);
    });

    test('停止方式的导出任务：重启后只在 manyoyo.id 对得上且容器已停止时启动', () => {
        const registry = createJobRegistry({ homeDir: home });
        const job = registry.create({ type: 'export', containers: ['s1', 's2'] });
        job.addPaused('s1', 'aaaaaaaaaaaaaaaa', 'stop');
        job.addPaused('s2', 'bbbbbbbbbbbbbbbb', 'stop');
        const started = [];
        createJobRegistry({ homeDir: home }).recover({
            containerIdOf: n => ({ s1: 'aaaaaaaaaaaaaaaa', s2: 'cccccccccccccccc' }[n]),
            isPaused: () => true, isStopped: () => true, unpause() { throw new Error('不该 unpause'); },
            start: n => started.push(n), removeContainer() {}, removePath() {}
        });
        expect(started).toEqual(['s1']);
    });

    test('损坏的任务记录被丢弃，不影响启动', () => {
        const dir = path.join(home, '.manyoyo', 'jobs');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '0123456789abcdef.json'), '{坏的');
        fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'bbbbbbbbbbbbbbbb', type: 'export' }));
        const registry = createJobRegistry({ homeDir: home });
        expect(registry.recover({ containerIdOf: () => '', isPaused: () => false, unpause() {}, removeContainer() {}, removePath() {} })).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
});
