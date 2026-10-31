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

    test('不再有“停止方式”：记录里就算有旧的 how=stop，重启后也不会启动容器，只处理仍处于暂停的', () => {
        const registry = createJobRegistry({ homeDir: home });
        const job = registry.create({ type: 'export', containers: ['s1'] });
        job.addPaused('s1', 'aaaaaaaaaaaaaaaa');
        const unpaused = [];
        createJobRegistry({ homeDir: home }).recover({
            containerIdOf: () => 'aaaaaaaaaaaaaaaa', isPaused: () => true, unpause: n => unpaused.push(n), start() { throw new Error('不该 start'); }, removeContainer() {}, removePath() {}
        });
        expect(unpaused).toEqual(['s1']);
    });

    describe('新状态 preparing / ready / waiting', () => {
        const recoverActions = { containerIdOf: () => '', isPaused: () => false, unpause() {}, removeContainer() {}, removePath() {} };

        test('都算“进行中”：锁容器（导入时预留新名字）、busyFor / reservedNames / active 都看得到，结束后释放', () => {
            const registry = createJobRegistry({ homeDir: home });
            const exporting = registry.create({ type: 'export', containers: ['a'], status: 'preparing' });
            const importing = registry.create({ type: 'import', containers: ['new1'], status: 'waiting' });
            expect(registry.busyFor('a')).toBe(exporting);
            expect(registry.busyFor('new1')).toBe(importing);
            expect([...registry.reservedNames()]).toEqual(['new1']);
            expect(registry.active()).toHaveLength(2);
            expect(registry.running()).toHaveLength(0);
            exporting.update({ status: 'ready' });
            expect(registry.busyFor('a')).toBe(exporting);
            exporting.update({ status: 'running' });
            expect(registry.running()).toEqual([exporting]);
            exporting.finish('done');
            importing.finish('cancelled');
            expect(registry.busyFor('a')).toBeNull();
            expect(registry.busyFor('new1')).toBeNull();
            expect(registry.hasActive()).toBe(false);
        });

        test('闸门把它们也算进去：准备中 / 等下载 / 等上传的容器同样 409', () => {
            const registry = createJobRegistry({ homeDir: home });
            registry.create({ type: 'export', containers: ['a'], status: 'preparing' });
            registry.create({ type: 'export', containers: ['b'], status: 'ready' });
            registry.create({ type: 'import', containers: ['c'], status: 'waiting' });
            for (const name of ['a', 'b', 'c']) expect(gateRequest(registry, 'POST', `/api/sessions/${name}/agent/stream`).status).toBe(409);
            expect(gateRequest(registry, 'GET', '/api/sessions/a/messages')).toBeNull();
        });

        test('取消：准备中给信号（由准备流程收尾）；等下载 / 等上传直接结束；已结束的返回 false', () => {
            const registry = createJobRegistry({ homeDir: home });
            const preparing = registry.create({ type: 'export', containers: ['a'], status: 'preparing' });
            const ready = registry.create({ type: 'export', containers: ['b'], status: 'ready' });
            const waiting = registry.create({ type: 'import', containers: ['c'], status: 'waiting' });
            expect(registry.cancel(preparing.id)).toBe(true);
            expect(preparing.status).toBe('preparing');
            expect(preparing.signal.aborted).toBe(true);
            expect(() => preparing.check()).toThrow(JobCancelled);
            expect(registry.cancel(ready.id)).toBe(true);
            expect(ready.status).toBe('cancelled');
            expect(registry.cancel(waiting.id)).toBe(true);
            expect(waiting.status).toBe('cancelled');
            expect(registry.cancel(ready.id)).toBe(false);
        });

        test('落盘：三个新状态都有记录，serve 重启后标成已中断（没有暂停过任何容器，不需要恢复动作）', () => {
            const registry = createJobRegistry({ homeDir: home });
            const ids = ['preparing', 'ready', 'waiting'].map(status => registry.create({ type: status === 'waiting' ? 'import' : 'export', containers: ['x'], status }).id);
            expect(fs.readdirSync(registry.dir).sort()).toEqual(ids.map(id => `${id}.json`).sort());
            const fresh = createJobRegistry({ homeDir: home });
            const reports = fresh.recover(recoverActions);
            expect(reports).toHaveLength(3);
            expect(fresh.list().map(job => job.status)).toEqual(['interrupted', 'interrupted', 'interrupted']);
            expect(fresh.busyFor('x')).toBeNull();
            expect(fs.readdirSync(registry.dir)).toEqual([]);
        });

        test('用户意图（取消）重启后仍然成立：取消过的任务不会被当成残留“复活”', () => {
            const registry = createJobRegistry({ homeDir: home });
            const ready = registry.create({ type: 'export', containers: ['x'], status: 'ready' });
            const waiting = registry.create({ type: 'import', containers: ['y'], status: 'waiting' });
            registry.cancel(ready.id);
            registry.cancel(waiting.id);
            expect(fs.readdirSync(registry.dir)).toEqual([]);
            const fresh = createJobRegistry({ homeDir: home });
            expect(fresh.recover(recoverActions)).toEqual([]);
            expect(fresh.list()).toEqual([]);
        });

        test('结束 / 超时释放准备好的清单与等待计时器', () => {
            const registry = createJobRegistry({ homeDir: home });
            const job = registry.create({ type: 'export', containers: ['x'], status: 'ready' });
            job.prepared = { big: true };
            job.waitTimer = setTimeout(() => {}, 100000);
            job.finish('cancelled');
            expect(job.prepared).toBeNull();
        });
    });

    test('任务结束时还有没能恢复的暂停容器：记录继续留着，下次启动恢复它；恢复完成后记录才删除', () => {
        const registry = createJobRegistry({ homeDir: home });
        const job = registry.create({ type: 'export', containers: ['stuck'] });
        job.addPaused('stuck', 'aaaaaaaaaaaaaaaa');
        job.finish('failed', { error: '恢复运行失败' });
        expect(fs.readdirSync(registry.dir)).toEqual([`${job.id}.json`]);
        const unpaused = [];
        const fresh = createJobRegistry({ homeDir: home });
        fresh.recover({ containerIdOf: () => 'aaaaaaaaaaaaaaaa', isPaused: () => true, unpause: n => unpaused.push(n), removeContainer() {}, removePath() {} });
        expect(unpaused).toEqual(['stuck']);
        expect(fs.readdirSync(registry.dir)).toEqual([]);
        // 没有暂停容器的失败任务不留记录
        const plain = registry.create({ type: 'export', containers: ['ok'] });
        plain.finish('failed', { error: 'x' });
        expect(fs.readdirSync(registry.dir)).toEqual([]);
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
