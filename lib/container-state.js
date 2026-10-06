'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { writeConfigFileSecure } = require('./secure-file');
const { parseEnvEntry } = require('./runtime-normalizers');

// 每个容器一个状态目录，按随机 manyoyo.id 索引（不按容器名：删了重建同名容器不会继承旧文件）
//   box/  读写挂到 /run/manyoyo/        env、autostart.sh、autostart.log（容器可写）
//   sys/  只读挂到 /run/manyoyo-sys/    init.sh、managed.env、net-required
//   network.json / meta.json            不挂进容器
const ID_RE = /^[0-9a-f]{16}$/;
const { ENV_KEY_RE, parseEnvText, serializeEnvEntries, formatEnvValue } = require('./env-text');
const MAX_ENV_BYTES = 256 * 1024;
const MAX_AUTOSTART_BYTES = 256 * 1024;
const INIT_TEMPLATE = path.join(__dirname, 'container-init.sh');

function isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

function containersRoot(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'containers');
}

function stateDir(homeDir, id) {
    if (!isValidId(id)) throw new Error(`非法的容器 id: ${id}`);
    return path.join(containersRoot(homeDir), id);
}

function paths(homeDir, id) {
    const dir = stateDir(homeDir, id);
    return {
        dir,
        box: path.join(dir, 'box'),
        sys: path.join(dir, 'sys'),
        env: path.join(dir, 'box', 'env'),
        autostart: path.join(dir, 'box', 'autostart.sh'),
        autostartLog: path.join(dir, 'box', 'autostart.log'),
        init: path.join(dir, 'sys', 'init.sh'),
        netRequired: path.join(dir, 'sys', 'net-required'),
        managedEnv: path.join(dir, 'sys', 'managed.env'),
        filesEnv: path.join(dir, 'sys', 'files.env'),
        envFiles: path.join(dir, 'env-files.json'),
        network: path.join(dir, 'network.json'),
        netStatus: path.join(dir, 'net-status.json'),
        egressToken: path.join(dir, 'egress-token'),
        meta: path.join(dir, 'meta.json')
    };
}

// 宿主机写入前的严格校验：沿用 parseEnvEntry 的字符限制与 key 规则
function validateEnvText(text, parseEnvEntry) {
    const body = String(text || '');
    if (Buffer.byteLength(body) > MAX_ENV_BYTES) throw new Error('环境变量内容过大');
    const { entries, invalid } = parseEnvText(body);
    if (invalid.length) throw new Error(`第 ${invalid[0].line} 行不是合法的 KEY=VALUE: ${invalid[0].reason}`);
    entries.forEach(entry => parseEnvEntry(`${entry.key}=${entry.value}`));
    return entries;
}

// NO_PROXY 由 Playwright 集成在原值上追加，必须留在容器级 env，不能被用户 env 文件覆盖
const CONTAINER_LEVEL_ENV_KEYS = new Set(['NO_PROXY', 'no_proxy']);

// ['--env', 'K=V', ...] → ['K=V', ...]
function envArgsToLines(flatArgs) {
    const out = [];
    for (let i = 0; i + 1 < (flatArgs || []).length; i += 2) {
        if (flatArgs[i] === '--env') out.push(flatArgs[i + 1]);
    }
    return out;
}

function envLineKey(line) {
    return String(line).split('=')[0];
}

// 从扁平 --env 参数里去掉指定 key（这些 key 改由 box/env 提供）
function stripEnvKeys(flatArgs, keys) {
    const out = [];
    for (let i = 0; i < (flatArgs || []).length; i += 2) {
        if (flatArgs[i] === '--env' && keys.has(envLineKey(flatArgs[i + 1]))) continue;
        out.push(flatArgs[i], flatArgs[i + 1]);
    }
    return out;
}

// 用户 env 拆成要进 box/env 的行（不含容器级 key）
function userEnvLines(flatArgs) {
    return envArgsToLines(flatArgs).filter(line => !CONTAINER_LEVEL_ENV_KEYS.has(envLineKey(line)));
}

// box/ 是读写挂进容器的目录，里面的文件是**不可信输入**：容器里的进程可以把 env 换成 FIFO（宿主机读会永久阻塞）、
// 指向宿主机文件的符号链接（读会拿到别的文件、写会覆盖别的文件）或几 GB 的大文件。
// 所以 box/ 里的文件一律：O_NOFOLLOW|O_NONBLOCK 打开 → fstat 必须是普通文件 → 大小有上限；写入用同目录 tmp + rename
// （rename 替换的是目录项本身，不会跟随符号链接）。
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

function readBoxText(file, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (e) {
        if (e.code === 'ENOENT') return { text: '' };
        return { text: '', unsafe: e.code === 'ELOOP' ? '是符号链接' : `无法读取（${e.code}）` };
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { text: '', unsafe: '不是普通文件' };
        if (stat.size > maxBytes) return { text: '', unsafe: '文件过大' };
        const buffer = Buffer.alloc(stat.size);
        const read = stat.size ? fs.readSync(fd, buffer, 0, stat.size, 0) : 0;
        return { text: buffer.toString('utf-8', 0, read), mtimeMs: stat.mtimeMs };
    } finally {
        fs.closeSync(fd);
    }
}

function writeBoxFile(file, data, mode = 0o600) {
    try {
        if (fs.lstatSync(file).isDirectory()) fs.rmSync(file, { recursive: true, force: true });
    } catch (e) { /* 不存在 */ }
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
        fs.chmodSync(tmp, mode);
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 尽力清理 */ }
        throw error;
    }
}

function ensureDir(dir, mode) {
    fs.mkdirSync(dir, { recursive: true, mode });
    fs.chmodSync(dir, mode);
}

// 目录 0700 只限制宿主机其他用户；容器经 rootless 映射/rootful root 访问，不受影响
function writeFileAtomic(filePath, data, mode = 0o600) {
    writeConfigFileSecure(filePath, data);
    if (mode !== 0o600) fs.chmodSync(filePath, mode);
}

/**
 * 创建状态目录与初始文件。
 * @param {object} options
 * @param {string} options.homeDir
 * @param {string} [options.id]
 * @param {string[]} [options.envLines] KEY=VALUE（已校验）
 * @param {string} [options.autostart] 自启动脚本
 * @param {object} [options.meta]
 * @param {boolean} [options.netRequired]
 * @param {object} [options.network] 已校验的网络策略（见 lib/network-policy.js）
 */
function createState(options) {
    const homeDir = options.homeDir || os.homedir();
    const id = options.id || newId();
    const p = paths(homeDir, id);
    ensureDir(path.join(homeDir, '.manyoyo'), 0o700);
    ensureDir(containersRoot(homeDir), 0o700);
    ensureDir(p.dir, 0o700);
    ensureDir(p.box, 0o700);
    ensureDir(p.sys, 0o700);
    // envLines 是成形的 KEY=VALUE（值是字面量）：按统一语法写出（需要时加引号），解析时才能原样读回
    const envText = serializeEnvEntries((options.envLines || []).map(line => {
        const i = String(line).indexOf('=');
        return { key: String(line).slice(0, i), value: String(line).slice(i + 1) };
    }));
    writeBoxFile(p.env, envText);
    writeEnvFileList(homeDir, id, options.envFiles || []);
    writeBoxFile(p.autostart, String(options.autostart || ''));
    refreshInit(homeDir, id);
    if (!fs.existsSync(p.managedEnv)) writeFileAtomic(p.managedEnv, '');
    setNetRequired(homeDir, id, Boolean(options.netRequired));
    if (options.network) writeNetworkRaw(homeDir, id, options.network);
    writeMeta(homeDir, id, { id, createdAt: new Date().toISOString(), ...(options.meta || {}) });
    return { id, ...p };
}

// 每次创建/启动前用仓库里的模板刷新，npm 升级后旧容器下次启动即用新 init
function refreshInit(homeDir, id) {
    const p = paths(homeDir, id);
    ensureDir(p.sys, 0o700);
    writeFileAtomic(p.init, fs.readFileSync(INIT_TEMPLATE, 'utf-8'), 0o755);
}

// 防御：别的 manyoyo 实例的容器 / 已删容器的 id 不能因为一次写入就凭空建出状态目录
function assertStateExists(homeDir, id) {
    if (!stateExists(homeDir, id)) throw new Error(`状态目录不存在: ${id}`);
}

function setNetRequired(homeDir, id, required) {
    assertStateExists(homeDir, id);
    const p = paths(homeDir, id);
    if (required) {
        writeFileAtomic(p.netRequired, '1\n');
    } else {
        fs.rmSync(p.netRequired, { force: true });
    }
}

// ---- 环境变量文件：宿主机上的绝对路径列表，每次 exec 现读（所以文件改了下一条命令就生效） ----
const MAX_ENV_FILES = 20;

function normalizeEnvFileList(list) {
    if (!Array.isArray(list)) throw new Error('环境变量文件必须是数组');
    if (list.length > MAX_ENV_FILES) throw new Error(`环境变量文件最多 ${MAX_ENV_FILES} 个`);
    const out = [];
    list.forEach(item => {
        const file = String(item === undefined || item === null ? '' : item).trim();
        if (!file) return;
        if (file.includes('\0') || !path.isAbsolute(file)) throw new Error(`环境变量文件只支持绝对路径: ${file.slice(0, 80)}`);
        if (!out.includes(file)) out.push(file);
    });
    return out;
}

// 环境变量文件内容：统一语法解析，值里含 parseEnvEntry 禁止字符的行记为 invalid 并跳过（不再静默丢弃）
function parseEnvFileContent(text) {
    const parsed = parseEnvText(text);
    const entries = [];
    const invalid = [...parsed.invalid];
    parsed.entries.forEach(entry => {
        try {
            parseEnvEntry(`${entry.key}=${entry.value}`);
            entries.push(entry);
        } catch (e) {
            invalid.push({ line: entry.line, text: `${entry.key}=…`, reason: e.message });
        }
    });
    return { entries, invalid };
}

function readEnvFileList(homeDir, id) {
    try {
        const parsed = JSON.parse(fs.readFileSync(paths(homeDir, id).envFiles, 'utf-8'));
        return Array.isArray(parsed.files) ? parsed.files.filter(f => typeof f === 'string') : [];
    } catch (e) {
        return [];
    }
}

function writeEnvFileList(homeDir, id, list) {
    const files = normalizeEnvFileList(list);
    writeFileAtomic(paths(homeDir, id).envFiles, `${JSON.stringify({ files }, null, 2)}\n`);
    syncFilesEnv(homeDir, id);
    return files;
}

/**
 * 逐个读取环境变量文件并解析（语法同「环境变量」文本）。值里含 parseEnvEntry 禁止的字符的行记为 invalid 并跳过，
 * 文件不存在 / 不是普通文件 / 太大记 error。读不到的文件不影响其他文件。
 */
function readEnvFiles(homeDir, id) {
    return readEnvFileList(homeDir, id).map(file => {
        const result = { path: file, exists: false, error: '', entries: [], invalid: [] };
        let text;
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) { result.error = '不是普通文件'; return result; }
            if (stat.size > MAX_ENV_BYTES) { result.error = '文件过大'; return result; }
            text = fs.readFileSync(file, 'utf-8');
            result.exists = true;
        } catch (e) {
            result.error = e.code === 'ENOENT' ? '文件不存在' : `无法读取（${e.code || e.message}）`;
            return result;
        }
        Object.assign(result, parseEnvFileContent(text));
        return result;
    });
}

function envFileEntries(homeDir, id) {
    const entries = [];
    readEnvFiles(homeDir, id).forEach(file => file.entries.forEach(entry => entries.push({ key: entry.key, value: entry.value })));
    return entries;
}

// 容器内 init 读不到宿主机文件：把当前内容快照进只读挂载的 sys/files.env（创建、保存、每次下发规则时刷新），
// 供自启动脚本使用；exec 则始终现读文件。
function syncFilesEnv(homeDir, id) {
    // 写成统一语法（需要时加引号），init 用同一套规则读回来
    writeFileAtomic(paths(homeDir, id).filesEnv, serializeEnvEntries(envFileEntries(homeDir, id)));
}

function stateExists(homeDir, id) {
    return isValidId(id) && fs.existsSync(paths(homeDir, id).dir);
}

function hashOf(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function readEnv(homeDir, id) {
    const read = readBoxText(paths(homeDir, id).env, MAX_ENV_BYTES);
    return { text: read.text, ...parseEnvText(read.text), mtimeMs: read.mtimeMs || 0, etag: hashOf(read.text), unsafe: read.unsafe || '' };
}

/**
 * 写 env 文本。ifMatch 与当前 etag 不一致说明容器内同时改过，抛 code=CONFLICT。
 */
function writeEnv(homeDir, id, text, { ifMatch, parseEnvEntry } = {}) {
    const current = readEnv(homeDir, id);
    if (ifMatch !== undefined && ifMatch !== null && ifMatch !== current.etag) {
        const error = new Error('容器内的环境变量已被修改');
        error.code = 'CONFLICT';
        throw error;
    }
    if (parseEnvEntry) validateEnvText(text, parseEnvEntry);
    const body = String(text || '');
    writeBoxFile(paths(homeDir, id).env, body.endsWith('\n') || !body ? body : `${body}\n`);
    return readEnv(homeDir, id);
}

function readAutostart(homeDir, id) {
    return readBoxText(paths(homeDir, id).autostart, MAX_AUTOSTART_BYTES).text;
}

function writeAutostart(homeDir, id, script) {
    const body = String(script || '');
    if (Buffer.byteLength(body) > MAX_AUTOSTART_BYTES) throw new Error('自启动脚本过大');
    writeBoxFile(paths(homeDir, id).autostart, body);
}

// 倒序只读尾部，不全量读取
function readAutostartLogTail(homeDir, id, maxBytes = 16 * 1024) {
    const file = paths(homeDir, id).autostartLog;
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (e) {
        return e.code === 'ENOENT' ? '' : `（日志文件不可读：${e.code === 'ELOOP' ? '是符号链接' : e.code}）`;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return '（日志文件不是普通文件）';
        const length = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, stat.size - length);
        return buffer.toString('utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

function writeManagedEnv(homeDir, id, entries) {
    assertStateExists(homeDir, id);
    writeFileAtomic(paths(homeDir, id).managedEnv, entries.length ? `${entries.join('\n')}\n` : '');
}

function readMeta(homeDir, id) {
    try {
        return JSON.parse(fs.readFileSync(paths(homeDir, id).meta, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function writeMeta(homeDir, id, meta) {
    writeFileAtomic(paths(homeDir, id).meta, `${JSON.stringify(meta, null, 2)}\n`);
}

// 网络策略原样存取（校验在 lib/network-policy.js）；没有文件返回 null
function readNetworkRaw(homeDir, id) {
    try {
        return JSON.parse(fs.readFileSync(paths(homeDir, id).network, 'utf-8'));
    } catch (e) {
        return null;
    }
}

function writeNetworkRaw(homeDir, id, policy) {
    writeFileAtomic(paths(homeDir, id).network, `${JSON.stringify(policy, null, 2)}\n`);
}

// 最近一次规则下发结果：{status: 'applied'|'error', message, at}
function readNetStatus(homeDir, id) {
    try {
        return JSON.parse(fs.readFileSync(paths(homeDir, id).netStatus, 'utf-8'));
    } catch (e) {
        return null;
    }
}

function writeNetStatus(homeDir, id, status) {
    assertStateExists(homeDir, id);
    writeFileAtomic(paths(homeDir, id).netStatus, `${JSON.stringify(status)}\n`);
}

// 过滤代理的容器凭据：256 bit 随机，只存宿主机侧（不挂进容器，容器从自己的 managed.env 拿到带凭据的代理地址）
function readEgressToken(homeDir, id) {
    try {
        return fs.readFileSync(paths(homeDir, id).egressToken, 'utf-8').trim() || null;
    } catch (e) {
        return null;
    }
}

function ensureEgressToken(homeDir, id) {
    const existing = readEgressToken(homeDir, id);
    if (existing) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    writeFileAtomic(paths(homeDir, id).egressToken, `${token}\n`);
    return token;
}

function removeState(homeDir, id) {
    if (!isValidId(id)) return false;
    fs.rmSync(stateDir(homeDir, id), { recursive: true, force: true });
    return true;
}

function listStateIds(homeDir) {
    try {
        return fs.readdirSync(containersRoot(homeDir)).filter(isValidId);
    } catch (e) {
        return [];
    }
}

// 状态目录里没有对应容器的 id（不自动删，避免切换运行时时误删）
function findOrphans(homeDir, liveIds) {
    const live = new Set(liveIds);
    return listStateIds(homeDir).filter(id => !live.has(id));
}

module.exports = {
    ID_RE,
    ENV_KEY_RE,
    isValidId,
    newId,
    readBoxText,
    writeBoxFile,
    MAX_ENV_BYTES,
    envArgsToLines,
    envLineKey,
    stripEnvKeys,
    userEnvLines,
    containersRoot,
    stateDir,
    paths,
    parseEnvText,
    serializeEnvEntries,
    formatEnvValue,
    validateEnvText,
    createState,
    refreshInit,
    setNetRequired,
    stateExists,
    normalizeEnvFileList,
    readEnvFileList,
    writeEnvFileList,
    readEnvFiles,
    parseEnvFileContent,
    envFileEntries,
    syncFilesEnv,
    readEnv,
    writeEnv,
    readAutostart,
    writeAutostart,
    readAutostartLogTail,
    writeManagedEnv,
    readMeta,
    writeMeta,
    readNetworkRaw,
    writeNetworkRaw,
    readNetStatus,
    writeNetStatus,
    readEgressToken,
    ensureEgressToken,
    removeState,
    listStateIds,
    findOrphans
};
