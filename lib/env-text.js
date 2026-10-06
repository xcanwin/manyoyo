'use strict';

// 环境变量的唯一语法（Web「环境变量」文本、容器内 /run/manyoyo/env、环境变量文件、容器内 init 都按它解析；
// 前端 frontend/src/lib/container-manage.ts 与 lib/container-init.sh 各有一份等价实现，用同一组语料测试）：
//   - 一行一项 `KEY=VALUE`，空行与 `#` 开头的行忽略；
//   - 与 docker / podman 的 env-file 一致：不展开变量、不执行命令，值里的空格不需要引号（`KEY=abc 123`）；
//   - 兼容 shell / dotenv 常见写法：可选的 `export ` 前缀；`=` 两侧的空白；值两端成对的 "…" 或 '…' 会被去掉
//     （docker 自己会把引号当成值的一部分，这里去掉更符合直觉）。想让值保留首尾的引号，就再包一层引号。
//   - 写出时（serializeEnvEntries）只在值首尾有空白、或首尾恰好是一对引号时才加引号，其余原样，所以
//     表格里填的 `abc 123` 在文本里就是 `KEY=abc 123`。
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/;

function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        return v.slice(1, -1);
    }
    return v;
}

/**
 * @returns {{entries: {key:string,value:string,line:number}[], invalid: {line:number,text:string,reason:string}[]}}
 */
function parseEnvText(text) {
    const entries = [];
    const invalid = [];
    String(text || '').split('\n').forEach((raw, index) => {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const m = LINE_RE.exec(trimmed);
        if (!m) {
            invalid.push({ line: index + 1, text: line, reason: '缺少 KEY=VALUE' });
            return;
        }
        if (!ENV_KEY_RE.test(m[1])) {
            invalid.push({ line: index + 1, text: line, reason: `key 非法: ${m[1]}` });
            return;
        }
        entries.push({ key: m[1], value: unquote(m[2]), line: index + 1 });
    });
    return { entries, invalid };
}

function needsQuote(value) {
    return /^\s|\s$/.test(value)
        || (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'")));
}

function formatEnvValue(value) {
    if (!needsQuote(value)) return value;
    const q = value[0] === '"' ? "'" : '"';
    return `${q}${value}${q}`;
}

function serializeEnvEntries(entries) {
    const lines = entries.filter(entry => String(entry.key).trim()).map(entry => `${String(entry.key).trim()}=${formatEnvValue(entry.value)}`);
    return lines.length ? `${lines.join('\n')}\n` : '';
}

module.exports = { ENV_KEY_RE, parseEnvText, serializeEnvEntries, formatEnvValue };
