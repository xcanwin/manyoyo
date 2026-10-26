'use strict';

// 容器导出 / 导入任务：登记、进度、取消、闸门，以及 serve 重启后的恢复。
// 任务记录落盘到 ~/.manyoyo/jobs/<id>.json：记下“被本任务暂停的容器”和“本任务新建的容器 / 目录 / 历史文件”，
// serve 被强杀后启动时据此恢复暂停、撤销没做完的导入。恢复时只动记录在案、且 manyoyo.id 对得上的容器（宁可删不掉）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeConfigFileSecure } = require('../secure-file');

const JOB_ID_RE = /^[0-9a-f]{16}$/;

class JobCancelled extends Error {
    constructor() {
        super('任务已取消');
        this.name = 'JobCancelled';
    }
}

function jobsDir(homeDir) {
    return path.join(homeDir, '.manyoyo', 'jobs');
}

function createJobRegistry(options = {}) {
    const homeDir = options.homeDir || os.homedir();
    const dir = jobsDir(homeDir);
    const jobs = new Map();
    const FINISHED_KEEP = 20;

    function persist(job) {
        if (job.status !== 'running') {
            try { fs.unlinkSync(path.join(dir, `${job.id}.json`)); } catch (error) { /* 没落盘过 */ }
            return;
        }
        try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const data = { ...job.record() };
            writeConfigFileSecure(path.join(dir, `${job.id}.json`), `${JSON.stringify(data)}\n`);
        } catch (error) {
            // 落盘失败不影响任务本身，只是崩溃后无法自动恢复
        }
    }

    function makeJob({ type, containers, meta = {}, id: fixedId }) {
        const id = fixedId || crypto.randomBytes(8).toString('hex');
        const job = {
            id,
            type,
            containers: [...containers],
            status: 'running',
            stage: '',
            container: '',
            bytes: 0,
            estimate: Number(meta.estimate) || 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: '',
            result: null,
            paused: [],
            created: { containers: [], dirs: [], historyFiles: [] },
            partFile: '',
            cancelRequested: false,
            meta,
            // 给界面看的快照（不含内部路径）
            view() {
                return {
                    id: job.id,
                    type: job.type,
                    status: job.status,
                    containers: job.containers,
                    stage: job.stage,
                    container: job.container,
                    bytes: job.bytes,
                    estimate: job.estimate,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt,
                    error: job.error,
                    result: job.result,
                    cancelRequested: job.cancelRequested
                };
            },
            // 落盘的记录：恢复需要的内部信息
            record() {
                return {
                    id: job.id,
                    type: job.type,
                    containers: job.containers,
                    startedAt: job.startedAt,
                    paused: job.paused,
                    created: job.created,
                    partFile: job.partFile
                };
            },
            update(patch) {
                Object.assign(job, patch);
                persist(job);
            },
            check() {
                if (job.cancelRequested) throw new JobCancelled();
            },
            addBytes(n) {
                job.bytes += n;
            },
            addPaused(name, id2) {
                job.paused.push({ name, id: id2 });
                persist(job);
            },
            removePaused(name) {
                job.paused = job.paused.filter(item => item.name !== name);
                persist(job);
            },
            addCreated(kind, value) {
                job.created[kind].push(value);
                persist(job);
            },
            finish(status, extra = {}) {
                job.status = status;
                job.finishedAt = new Date().toISOString();
                Object.assign(job, extra);
                persist(job);
                // 只留最近几个已结束的任务
                const finished = [...jobs.values()].filter(item => item.status !== 'running');
                finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP)).forEach(item => jobs.delete(item.id));
            }
        };
        jobs.set(id, job);
        persist(job);
        return job;
    }

    return {
        dir,
        create: makeJob,
        get: id => jobs.get(id) || null,
        list: () => [...jobs.values()].map(job => job.view()),
        // 正在跑的、涉及这个容器的任务
        busyFor(containerName) {
            for (const job of jobs.values()) {
                if (job.status === 'running' && job.containers.includes(containerName)) return job;
            }
            return null;
        },
        hasRunning: () => [...jobs.values()].some(job => job.status === 'running'),
        cancel(id) {
            const job = jobs.get(id);
            if (!job || job.status !== 'running') return false;
            job.cancelRequested = true;
            return true;
        },

        /**
         * 启动时恢复。actions：
         *   containerIdOf(name) → 当前容器的 manyoyo.id（不存在返回 ''）
         *   isPaused(name) → 容器当前是否处于暂停
         *   unpause(name)
         *   removeContainer(name)
         *   removePath(p)       删目录或文件
         * 返回处理过的任务记录列表（status: 'interrupted'）。
         */
        recover(actions) {
            const handled = [];
            let names = [];
            try { names = fs.readdirSync(dir); } catch (error) { return handled; }
            for (const file of names) {
                if (!/^[0-9a-f]{16}\.json$/.test(file)) continue;
                const full = path.join(dir, file);
                let record;
                try {
                    record = JSON.parse(fs.readFileSync(full, 'utf8'));
                } catch (error) {
                    try { fs.unlinkSync(full); } catch (e) { /* ignore */ }
                    continue;
                }
                if (!record || record.id !== file.slice(0, -5)) {
                    try { fs.unlinkSync(full); } catch (error) { /* ignore */ }
                    continue;
                }
                const report = { id: record.id, type: record.type, containers: record.containers || [], restored: [], removed: [], skipped: [] };
                for (const item of Array.isArray(record.paused) ? record.paused : []) {
                    try {
                        if (item && item.id && actions.containerIdOf(item.name) === item.id && actions.isPaused(item.name)) {
                            actions.unpause(item.name);
                            report.restored.push(item.name);
                        } else {
                            report.skipped.push(item && item.name);
                        }
                    } catch (error) {
                        report.skipped.push(item && item.name);
                    }
                }
                const created = record.created || {};
                for (const item of Array.isArray(created.containers) ? created.containers : []) {
                    try {
                        if (item && item.id && actions.containerIdOf(item.name) === item.id) {
                            actions.removeContainer(item.name);
                            report.removed.push(item.name);
                        } else {
                            report.skipped.push(item && item.name);
                        }
                    } catch (error) {
                        report.skipped.push(item && item.name);
                    }
                }
                for (const kind of ['dirs', 'historyFiles']) {
                    for (const p of Array.isArray(created[kind]) ? created[kind] : []) {
                        try { actions.removePath(p); report.removed.push(p); } catch (error) { report.skipped.push(p); }
                    }
                }
                if (record.partFile) {
                    try { actions.removePath(record.partFile); } catch (error) { /* ignore */ }
                }
                try { fs.unlinkSync(full); } catch (error) { /* ignore */ }
                // 登记成“已中断”，界面能看到
                const job = makeJob({ type: record.type, containers: report.containers, id: record.id });
                job.finish('interrupted', { error: 'serve 重启，任务已中断', result: report });
                handled.push(report);
            }
            return handled;
        }
    };
}

// 把请求路径归到某个容器：/api/sessions/<名>/… 与 /api/containers/<名>/…（名字可能是 容器~agent）。
// 返回 { container, tail }；与容器无关返回 null。
function containerOfPath(pathname, decode = decodeURIComponent) {
    const match = /^\/api\/(?:sessions|containers)\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return null;
    if (match[1] === 'orphans') return null;
    let name = match[1];
    try { name = decode(match[1]); } catch (error) { /* 保持原样 */ }
    return { container: name.split('~')[0], tail: match[2] || '' };
}

// 任务期间仍允许的只读请求：读消息、读详情（进度在 /api/jobs 与列表里）
const READONLY_TAILS = [/^\/messages$/, /^\/detail$/];

/**
 * 闸门：返回 null 表示放行，否则返回 { status:409, body }。
 */
function gateRequest(registry, method, pathname) {
    const target = containerOfPath(pathname);
    if (!target) return null;
    const job = registry.busyFor(target.container);
    if (!job) return null;
    if (method === 'GET' && READONLY_TAILS.some(re => re.test(target.tail.split('?')[0]))) return null;
    return {
        status: 409,
        body: { error: job.type === 'export' ? '正在导出，完成后可用' : '正在导入，完成后可用', busy: job.type, jobId: job.id }
    };
}

module.exports = { createJobRegistry, JobCancelled, containerOfPath, gateRequest, JOB_ID_RE, jobsDir };
