'use strict';

const fs = require('fs');
const path = require('path');
const {
    validateControlEvent,
    selectEventsAfterCursor,
    applyEventToProjection,
    projectSessionEvents
} = require('./events');

function getAggregateFileName(aggregateId) {
    return encodeURIComponent(String(aggregateId || '').trim());
}

class FileEventStore {
    constructor(rootDir) {
        this.rootDir = path.resolve(rootDir);
        this.eventsDir = path.join(this.rootDir, 'events');
        this.projectionsDir = path.join(this.rootDir, 'projections');
        // append() 的增量缓存：aggregateId -> { lastSeq, projection }。命中时
        // 避免每次追加都要整份重读 + 重新校验 + 重新投影该聚合的全部历史事件
        // （O(该聚合累计事件数)），只有本实例第一次碰到这个 aggregateId 才退回
        // read() 全量重建。仅作用于同一个长生命周期实例内，不跨进程/跨实例。
        this._appendCache = new Map();
    }

    getEventFilePath(aggregateId) {
        return path.join(this.eventsDir, `${getAggregateFileName(aggregateId)}.jsonl`);
    }

    getProjectionFilePath(aggregateId) {
        return path.join(this.projectionsDir, `${getAggregateFileName(aggregateId)}.json`);
    }

    read(aggregateId) {
        const normalizedAggregateId = String(aggregateId || '').trim();
        const filePath = this.getEventFilePath(normalizedAggregateId);
        if (!fs.existsSync(filePath)) {
            return [];
        }

        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const events = [];
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index].trim();
            if (!line) continue;
            try {
                const event = JSON.parse(line);
                validateControlEvent(event);
                if (event.aggregateId !== normalizedAggregateId) {
                    throw new Error('事件 aggregateId 与日志不一致');
                }
                events.push(event);
            } catch (error) {
                const isFinalLine = index === lines.length - 1;
                if (isFinalLine) {
                    break;
                }
                throw error;
            }
        }
        selectEventsAfterCursor(events, 0);
        return events;
    }

    _ensureCacheEntry(aggregateId) {
        let cached = this._appendCache.get(aggregateId);
        if (!cached) {
            const events = this.read(aggregateId);
            cached = {
                lastSeq: events.length ? events[events.length - 1].seq : 0,
                projection: projectSessionEvents(events)
            };
            this._appendCache.set(aggregateId, cached);
        }
        return cached;
    }

    // 调用方（例如 lib/web/server.js 的 appendWebSessionControlEvent）在构造下
    // 一个事件前，用这个方法拿"权威的下一个 seq"，不要再依赖自己单独维护的
    // 一份事件副本（如历史 JSON 里的 agentSession.events）——那份副本如果因为
    // 落盘节流而滞后，算出来的 seq 会与这里的内存缓存不一致，append() 时报错。
    getNextSeq(aggregateId) {
        const normalizedAggregateId = String(aggregateId || '').trim();
        return this._ensureCacheEntry(normalizedAggregateId).lastSeq + 1;
    }

    append(event) {
        validateControlEvent(event);
        const aggregateId = String(event.aggregateId || '').trim();
        const cached = this._ensureCacheEntry(aggregateId);
        const expectedSeq = cached.lastSeq ? cached.lastSeq + 1 : event.seq;
        if (event.seq !== expectedSeq) {
            throw new Error(`seq 必须连续递增，期望 ${expectedSeq}，实际 ${event.seq}`);
        }

        fs.mkdirSync(this.eventsDir, { recursive: true });
        fs.appendFileSync(this.getEventFilePath(aggregateId), `${JSON.stringify(event)}\n`);
        cached.projection = applyEventToProjection(cached.projection, event);
        cached.lastSeq = event.seq;
        this.saveProjection(aggregateId, cached.projection);
        return event;
    }

    loadProjection(aggregateId) {
        const events = this.read(aggregateId);
        const projection = projectSessionEvents(events);
        const projectionPath = this.getProjectionFilePath(aggregateId);
        if (!fs.existsSync(projectionPath)) {
            return projection;
        }
        try {
            const saved = JSON.parse(fs.readFileSync(projectionPath, 'utf-8'));
            if (saved && saved.aggregateId === projection.aggregateId && saved.lastSeq === projection.lastSeq) {
                return saved;
            }
        } catch (error) {
            // 以事件日志为准重建损坏的投影快照。
        }
        this.saveProjection(aggregateId, projection);
        return projection;
    }

    saveProjection(aggregateId, projection) {
        fs.mkdirSync(this.projectionsDir, { recursive: true });
        const targetPath = this.getProjectionFilePath(aggregateId);
        const temporaryPath = `${targetPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(projection)}\n`);
        fs.renameSync(temporaryPath, targetPath);
    }

    remove(aggregateId) {
        const eventFilePath = this.getEventFilePath(aggregateId);
        if (fs.existsSync(eventFilePath)) {
            fs.unlinkSync(eventFilePath);
        }
        const projectionFilePath = this.getProjectionFilePath(aggregateId);
        if (fs.existsSync(projectionFilePath)) {
            fs.unlinkSync(projectionFilePath);
        }
        this._appendCache.delete(String(aggregateId || '').trim());
    }
}

module.exports = {
    FileEventStore
};
