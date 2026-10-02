'use strict';

// 任务执行器：一次只跑一个任务（一个或多个阶段）。
//   mode = single  只跑指定的一个阶段
//   mode = step    一键执行整段，但每个“对外动作”阶段开始前都等页面逐步确认
//   mode = auto    一键执行整段，开始前一次性确认，之后不再询问
// 事件流（SSE）：log / stage / confirm / done，保留最近一批供晚加入的页面回放。

const { EventEmitter } = require('events');
const { STAGES, computeStages } = require('./stages');
const { ReleaseError } = require('./actions');

const EVENT_BUFFER = 3000;

class JobRunner extends EventEmitter {
    /**
     * @param {object} deps
     *   collect()        → Promise<facts>
     *   makeCtx(emitLog, signal) → ctx（见 actions.js）
     *   actions          阶段 id → async (ctx, params, facts)
     *   describe(id, facts, params) → string[]（确认弹窗里的命令）
     *   getState()       → 本地状态
     */
    constructor(deps) {
        super();
        this.deps = deps;
        this.current = null;
        this.events = [];
        this.seq = 0;
        this.pending = null;
    }

    emitEvent(event) {
        const full = { seq: ++this.seq, at: Date.now(), ...event };
        this.events.push(full);
        if (this.events.length > EVENT_BUFFER) this.events.shift();
        this.emit('event', full);
        return full;
    }

    snapshot() {
        const job = this.current;
        return job ? { id: job.id, mode: job.mode, stages: job.stages, status: job.status, currentStage: job.currentStage, error: job.error || '', confirm: this.pending ? this.pending.info : null } : null;
    }

    start({ stages, mode = 'single', params = {}, confirmed = false }) {
        if (this.current && this.current.status === 'running') throw new ReleaseError('BUSY', '已有任务在运行');
        if (!Array.isArray(stages) || stages.length === 0) throw new ReleaseError('BAD_REQUEST', '没有指定阶段');
        if (!['single', 'step', 'auto'].includes(mode)) throw new ReleaseError('BAD_REQUEST', `未知模式: ${mode}`);
        const defs = stages.map(id => STAGES.find(stage => stage.id === id));
        if (defs.some(def => !def)) throw new ReleaseError('BAD_REQUEST', `未知阶段: ${stages.join(', ')}`);
        if (mode === 'single' && defs.length !== 1) throw new ReleaseError('BAD_REQUEST', 'single 模式只能指定一个阶段');
        const needsConfirm = defs.some(def => def.external);
        // step 模式的确认在每个阶段开始前逐个进行；single / auto 必须在请求里明确确认
        if (needsConfirm && mode !== 'step' && confirmed !== true) throw new ReleaseError('CONFIRM_REQUIRED', '对外动作需要明确确认');
        const controller = new AbortController();
        const job = { id: `${Date.now()}`, mode, stages, params, status: 'running', currentStage: null, controller, error: '' };
        this.current = job;
        this.events = [];
        this.emitEvent({ type: 'start', mode, stages });
        this.execute(job).catch(error => {
            job.status = error.code === 'CANCELLED' ? 'cancelled' : 'failed';
            job.error = error.message;
            this.emitEvent({ type: 'done', status: job.status, error: job.error });
        });
        return this.snapshot();
    }

    async execute(job) {
        for (const id of job.stages) {
            if (job.controller.signal.aborted) throw new ReleaseError('CANCELLED', '已取消');
            job.currentStage = id;
            const def = STAGES.find(stage => stage.id === id);
            let facts = await this.deps.collect();
            let stage = computeStages(facts, this.deps.getState()).find(item => item.id === id);
            if (job.mode !== 'single' && stage.state === 'done') {
                this.emitEvent({ type: 'stage', stage: id, state: 'skipped', detail: stage.detail });
                continue;
            }
            // 服务端强制前置条件：不能只靠页面把按钮置灰（对外动作被阻塞时一律拒绝，不论模式）
            if (!this.deps.dryRun && stage.state === 'blocked' && (job.mode !== 'single' || def.external)) throw new ReleaseError('BLOCKED', `「${def.title}」被阻塞：${stage.detail}`);
            // 自动模式遇到“无法确认”的阶段（如镜像是否存在查不到）不擅自执行，停下来让人确认
            if (!this.deps.dryRun && job.mode === 'auto' && stage.state === 'warn') throw new ReleaseError('NEEDS_REVIEW', `「${def.title}」需要人工确认：${stage.detail}`);
            if (def.external && job.mode === 'step') await this.askConfirm(job, def, facts);
            this.emitEvent({ type: 'stage', stage: id, state: 'running' });
            const ctx = this.deps.makeCtx(line => this.emitEvent({ type: 'log', stage: id, line }), job.controller.signal);
            await this.deps.actions[id](ctx, job.params[id] || {}, facts);
            if (job.controller.signal.aborted) throw new ReleaseError('CANCELLED', '已取消');
            facts = await this.deps.collect();
            stage = computeStages(facts, this.deps.getState()).find(item => item.id === id);
            this.emitEvent({ type: 'stage', stage: id, state: 'finished', result: stage.state, detail: stage.detail });
            if (!this.deps.dryRun && job.mode !== 'single' && stage.state !== 'done' && id !== 'manual') {
                throw new ReleaseError('NOT_DONE', `「${def.title}」执行完但状态仍是 ${stage.state}：${stage.detail}`);
            }
        }
        job.status = 'succeeded';
        job.currentStage = null;
        this.emitEvent({ type: 'done', status: 'succeeded' });
    }

    askConfirm(job, def, facts) {
        const info = { stage: def.id, title: def.title, commands: this.deps.describe(def.id, facts, job.params[def.id] || {}) };
        return new Promise((resolve, reject) => {
            this.pending = { info, resolve, reject };
            this.emitEvent({ type: 'confirm', ...info });
        }).finally(() => { this.pending = null; });
    }

    approve(ok) {
        if (!this.pending) throw new ReleaseError('NO_PENDING', '没有等待确认的阶段');
        const { resolve, reject } = this.pending;
        if (ok) resolve();
        else reject(new ReleaseError('CANCELLED', '已拒绝，任务停止'));
    }

    cancel() {
        const job = this.current;
        if (!job || job.status !== 'running') return false;
        job.controller.abort();
        if (this.pending) this.pending.reject(new ReleaseError('CANCELLED', '已取消'));
        return true;
    }
}

module.exports = { JobRunner };
