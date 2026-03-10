function stripAnsi(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function sanitizeProcessArgv(argv) {
    if (!Array.isArray(argv)) {
        return [];
    }

    const result = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = String(argv[i] || '');
        if (arg === '--pass' || arg === '-P') {
            result.push(arg);
            if (i + 1 < argv.length) {
                result.push('****');
                i += 1;
            }
            continue;
        }
        if (arg.startsWith('--pass=')) {
            result.push('--pass=****');
            continue;
        }
        result.push(arg);
    }
    return result;
}

function sanitizeServeLogText(input) {
    let text = stripAnsi(String(input || ''));
    if (!text) return text;

    text = text.replace(/(--pass|-P)\s+\S+/gi, '$1 ****');
    text = text.replace(/("--pass"|"-P")\s*,\s*"[^"]*"/gi, '$1,"****"');
    text = text.replace(/--pass=([^\s'"]+)/gi, '--pass=****');
    text = text.replace(
        /\b(MANYOYO_SERVER_PASS|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY|OPENCODE_API_KEY)\s*=\s*([^\s'"]+)/gi,
        '$1=****'
    );
    text = text.replace(
        /(?<![-\w])("?(?:password|pass|token|api[_-]?key|authorization|cookie)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s]+)/gi,
        '$1"****"'
    );
    return text;
}

function sanitizeSensitiveData(obj) {
    const sensitiveKeys = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'AUTH', 'CREDENTIAL'];

    function sanitizeValue(key, value) {
        if (typeof value !== 'string') return value;
        const upperKey = key.toUpperCase();
        if (sensitiveKeys.some(k => upperKey.includes(k))) {
            if (value.length <= 8) return '****';
            return value.slice(0, 4) + '****' + value.slice(-4);
        }
        return value;
    }

    function sanitizeArray(arr) {
        return arr.map(item => {
            if (typeof item === 'string' && item.includes('=')) {
                const idx = item.indexOf('=');
                const key = item.slice(0, idx);
                const value = item.slice(idx + 1);
                return `${key}=${sanitizeValue(key, value)}`;
            }
            return item;
        });
    }

    const result = {};
    for (const [key, value] of Object.entries(obj || {})) {
        if (Array.isArray(value)) {
            result[key] = sanitizeArray(value);
        } else if (typeof value === 'object' && value !== null) {
            result[key] = sanitizeSensitiveData(value);
        } else {
            result[key] = sanitizeValue(key, value);
        }
    }
    return result;
}

function formatServeLogValue(value) {
    if (value instanceof Error) {
        return sanitizeServeLogText(value.stack || value.message || String(value));
    }
    if (typeof value === 'object' && value !== null) {
        try {
            return sanitizeServeLogText(JSON.stringify(sanitizeSensitiveData(value)));
        } catch (e) {
            return sanitizeServeLogText(String(value));
        }
    }
    return sanitizeServeLogText(String(value));
}

function getServeProcessSnapshot(processRef = process) {
    return {
        pid: processRef.pid,
        ppid: processRef.ppid,
        cwd: typeof processRef.cwd === 'function' ? processRef.cwd() : '',
        argv: sanitizeProcessArgv(Array.isArray(processRef.argv) ? processRef.argv.slice() : [])
    };
}

module.exports = {
    sanitizeProcessArgv,
    sanitizeServeLogText,
    sanitizeSensitiveData,
    formatServeLogValue,
    getServeProcessSnapshot
};
