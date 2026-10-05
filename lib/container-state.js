'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { writeConfigFileSecure } = require('./secure-file');

// 每个容器一个状态目录，按随机 manyoyo.id 索引（不按容器名：删了重建同名容器不会继承旧文件）
//   box/  读写挂到 /run/manyoyo/        env、autostart.sh、autostart.log（容器可写）
//   sys/  只读挂到 /run/manyoyo-sys/    init.sh、managed.env、net-required
//   network.json / meta.json            不挂进容器
const ID_RE = /^[0-9a-f]{16}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
        network: path.join(dir, 'network.json'),
        netStatus: path.join(dir, 'net-status.json'),
        egressToken: path.join(dir, 'egress-token'),
        meta: path.join(dir, 'meta.json')
    };
}

/**
 * 解析 env 文本：按第一个 = 切分，不去引号、不展开变量，跳过空行与 # 注释。
 * 非法行（key 不合法、没有 =）收进 invalid，调用方负责标红并跳过。
 * @returns {{entries: {key:string,value:string,line:number}[], invalid: {line:number,text:string,reason:string}[]}}
 */
function parseEnvText(text) {
    const entries = [];
    const invalid = [];
    String(text || '').split('\n').forEach((raw, index) => {
        const line = raw.replace(/\r$/, '');
        if (!line.trim() || line.startsWith('#')) return;
        const eq = line.indexOf('=');
        if (eq <= 0) {
            invalid.push({ line: index + 1, text: line, reason: '缺少 KEY=VALUE' });
            return;
        }
        const key = line.slice(0, eq);
        if (!ENV_KEY_RE.test(key)) {
            invalid.push({ line: index + 1, text: line, reason: `key 非法: ${key}` });
            return;
        }
        entries.push({ key, value: line.slice(eq + 1), line: index + 1 });
    });
    return { entries, invalid };
}

function serializeEnvEntries(entries) {
    return `${entries.map(entry => `${entry.key}=${entry.value}`).join('\n')}\n`;
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
    const envText = (options.envLines || []).length ? `${options.envLines.join('\n')}\n` : '';
    writeFileAtomic(p.env, envText);
    writeFileAtomic(p.autostart, String(options.autostart || ''), 0o600);
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

function setNetRequired(homeDir, id, required) {
    const p = paths(homeDir, id);
    if (required) {
        writeFileAtomic(p.netRequired, '1\n');
    } else {
        fs.rmSync(p.netRequired, { force: true });
    }
}

function stateExists(homeDir, id) {
    return isValidId(id) && fs.existsSync(paths(homeDir, id).dir);
}

function hashOf(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function readEnv(homeDir, id) {
    const p = paths(homeDir, id);
    let raw = '';
    let mtimeMs = 0;
    try {
        const stat = fs.statSync(p.env);
        if (stat.size > MAX_ENV_BYTES) throw new Error('环境变量文件过大');
        raw = fs.readFileSync(p.env, 'utf-8');
        mtimeMs = stat.mtimeMs;
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
    return { text: raw, ...parseEnvText(raw), mtimeMs, etag: hashOf(raw) };
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
    writeFileAtomic(paths(homeDir, id).env, body.endsWith('\n') || !body ? body : `${body}\n`);
    return readEnv(homeDir, id);
}

function readAutostart(homeDir, id) {
    const p = paths(homeDir, id);
    try {
        return fs.readFileSync(p.autostart, 'utf-8');
    } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
    }
}

function writeAutostart(homeDir, id, script) {
    const body = String(script || '');
    if (Buffer.byteLength(body) > MAX_AUTOSTART_BYTES) throw new Error('自启动脚本过大');
    writeFileAtomic(paths(homeDir, id).autostart, body);
}

// 倒序只读尾部，不全量读取
function readAutostartLogTail(homeDir, id, maxBytes = 16 * 1024) {
    const file = paths(homeDir, id).autostartLog;
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf-8');
    } finally {
        fs.closeSync(fd);
    }
}

function writeManagedEnv(homeDir, id, entries) {
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
    envArgsToLines,
    envLineKey,
    stripEnvKeys,
    userEnvLines,
    containersRoot,
    stateDir,
    paths,
    parseEnvText,
    serializeEnvEntries,
    validateEnvText,
    createState,
    refreshInit,
    setNetRequired,
    stateExists,
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
