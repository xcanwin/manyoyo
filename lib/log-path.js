const os = require('os');
const path = require('path');

function pad2(n) {
    return String(n).padStart(2, '0');
}

function getLocalDateTag(date = new Date()) {
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    return `${y}-${m}-${d}`;
}

function normalizeLogScope(scope) {
    return String(scope || 'general')
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'general';
}

function buildManyoyoLogPath(scope, date = new Date(), homeDir = os.homedir()) {
    const safeScope = normalizeLogScope(scope);
    const rootDir = path.join(homeDir, '.manyoyo', 'logs');
    const dir = path.join(rootDir, safeScope);
    const file = `${safeScope}-${getLocalDateTag(date)}.log`;

    return {
        rootDir,
        dir,
        path: path.join(dir, file),
        scope: safeScope,
        file
    };
}

module.exports = {
    getLocalDateTag,
    normalizeLogScope,
    buildManyoyoLogPath
};
