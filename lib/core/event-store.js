'use strict';

const fs = require('fs');
const path = require('path');
const {
    validateControlEvent,
    selectEventsAfterCursor,
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

    append(event) {
        validateControlEvent(event);
        const events = this.read(event.aggregateId);
        const expectedSeq = events.length ? events[events.length - 1].seq + 1 : event.seq;
        if (event.seq !== expectedSeq) {
            throw new Error(`seq 必须连续递增，期望 ${expectedSeq}，实际 ${event.seq}`);
        }

        fs.mkdirSync(this.eventsDir, { recursive: true });
        const eventFilePath = this.getEventFilePath(event.aggregateId);
        // 上一次追加被强杀在行中间时，文件末尾是没有换行的残缺行：先截掉它（read 本来也不认它），
        // 否则新事件会拼在它后面，残缺行变成中间行，之后每次 read 都会抛错
        this.dropIncompleteTail(eventFilePath);
        fs.appendFileSync(eventFilePath, `${JSON.stringify(event)}\n`);
        const projection = projectSessionEvents([...events, event]);
        this.saveProjection(event.aggregateId, projection);
        return event;
    }

    dropIncompleteTail(filePath) {
        if (!fs.existsSync(filePath)) {
            return;
        }
        const content = fs.readFileSync(filePath);
        if (!content.length || content[content.length - 1] === 0x0a) {
            return;
        }
        const lineStart = content.lastIndexOf(0x0a) + 1;
        try {
            JSON.parse(content.subarray(lineStart).toString('utf-8'));
            // 最后一行是完整事件，只是缺换行：补上换行，保留这条事件
            fs.appendFileSync(filePath, '\n');
        } catch (error) {
            fs.truncateSync(filePath, lineStart);
        }
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
    }
}

module.exports = {
    FileEventStore
};
