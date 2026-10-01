#!/usr/bin/env node
'use strict';

// 发布产物隐私扫描：目录 / tar(.gz/.xz/.zst) / 镜像归档（逐层解开）。
// 命中任何规则即退出码 1；命中内容只显示首尾几位，避免扫描日志本身泄露。
// 用法: node scripts/scan-release-artifacts.js [--allowlist f.json] [--build-user N]... [--build-host N]...
//                [--auto-identity] [--json] [--no-inventory] <目录|归档>...

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');

const CHUNK_BYTES = 4 * 1024 * 1024;
const OVERLAP_BYTES = 512;
const DEFAULT_MAX_DEPTH = 3;
const GENERIC_IDENTITIES = new Set(['root', 'runner', 'admin', 'user', 'ubuntu', 'localhost', 'docker', 'node']);

const CONTENT_RULES = [
    { id: 'local-path', regex: /\/(?:Users|home)\/[A-Za-z0-9._-]{1,64}/g },
    // 各段限长：二进制里长串字母数字会让无界量词退化成 O(n²)
    { id: 'email', regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g },
    { id: 'private-key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
    { id: 'token', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { id: 'token', regex: /\bsk-[A-Za-z0-9]{20,}/g },
    { id: 'token', regex: /\bghp_[A-Za-z0-9]{36}/g },
    { id: 'token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
    { id: 'token', regex: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: 'token', regex: /\bxox[bp]-[A-Za-z0-9-]{10,}/g }
];

const SENSITIVE_BASENAMES = [
    /^\.env(?:\..+)?$/,
    /^\.npmrc$/,
    /^manyoyo\.json$/,
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/,
    /\.pem$/i,
    /\.p12$/i
];

function mask(value) {
    const text = String(value);
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 3)}…${text.slice(-2)}(${text.length}字符)`;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRules(options = {}) {
    const rules = CONTENT_RULES.map(rule => ({ id: rule.id, regex: new RegExp(rule.regex.source, 'g') }));
    for (const value of options.denyStrings || []) {
        const text = String(value || '');
        if (text.length >= 3) {
            rules.push({ id: 'build-identity', regex: new RegExp(escapeRegExp(text), 'g') });
        }
    }
    return rules;
}

function validateAllowlist(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('允许列表必须是数组');
    }
    entries.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') throw new Error(`允许列表第 ${index + 1} 条不是对象`);
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw new Error(`允许列表第 ${index + 1} 条缺少 reason（每条必须写明原因）`);
        }
        if (typeof entry.rule !== 'string' || !entry.rule) throw new Error(`允许列表第 ${index + 1} 条缺少 rule`);
        if (!['value', 'valuePattern', 'path', 'pathPattern'].some(key => typeof entry[key] === 'string' && entry[key])) {
            throw new Error(`允许列表第 ${index + 1} 条必须至少限定 value / valuePattern / path / pathPattern 之一，不允许整条规则放行`);
        }
    });
    return entries;
}

function findAllowEntry(allowlist, hit) {
    return allowlist.find(entry => {
        if (entry.rule !== '*' && entry.rule !== hit.rule) return false;
        if (entry.value && entry.value !== hit.raw) return false;
        if (entry.valuePattern && !new RegExp(entry.valuePattern).test(hit.raw)) return false;
        if (entry.path && !hit.file.includes(entry.path)) return false;
        if (entry.pathPattern && !new RegExp(entry.pathPattern).test(hit.file)) return false;
        return true;
    });
}

const DECOMPRESSORS = { gzip: null, xz: ['xz', '-dc'], zstd: ['zstd', '-dc'], bzip2: ['bzip2', '-dc'] };

function detectArchiveKind(head) {
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
    if (head.length >= 6 && head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
    if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
    if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
    if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
    return '';
}

function readHead(filePath, length = 512) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, 0);
        return buffer.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

function removeTree(dir) {
    spawnSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
}

async function scanStreamContent(stream, rules, onMatch) {
    const seen = new Set();
    let tail = Buffer.alloc(0);
    let consumed = 0;
    let first = true;
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of stream) {
        hash.update(chunk);
        size += chunk.length;
        const buffer = Buffer.concat([tail, chunk]);
        const text = buffer.toString('latin1');
        const base = consumed - tail.length;
        for (const rule of rules) {
            rule.regex.lastIndex = 0;
            let match;
            while ((match = rule.regex.exec(text)) !== null) {
                if (match[0].length === 0) {
                    rule.regex.lastIndex += 1;
                    continue;
                }
                if (!first && match.index + match[0].length <= tail.length) continue;
                const offset = base + match.index;
                const key = `${rule.id}:${offset}`;
                if (seen.has(key)) continue;
                seen.add(key);
                onMatch(rule.id, match[0], offset);
            }
        }
        consumed += chunk.length;
        tail = buffer.subarray(Math.max(0, buffer.length - OVERLAP_BYTES));
        first = false;
    }
    return { size, sha256: hash.digest('hex') };
}

/**
 * @param {string[]} targets 目录或文件
 * @param {{denyStrings?: string[], allowlist?: Object[], maxDepth?: number, tmpRoot?: string}} [options]
 */
async function scanTargets(targets, options = {}) {
    const rules = buildRules(options);
    const allowlist = validateAllowlist(options.allowlist || []);
    const maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;
    // 不扫描的路径（正则，匹配展示路径）：用于“已有专门扫描/校验”的部分，如镜像归档与官方 VM 磁盘
    const excludes = (options.excludes || []).map(pattern => new RegExp(pattern));
    const isExcluded = display => excludes.some(pattern => pattern.test(display));
    const tmpRoot = options.tmpRoot || os.tmpdir();
    // unscanned：内容没能被检查的文件（解不开/解包失败/嵌套超限且无法流式扫描），一律视为失败，不能当作“通过”
    const result = { hits: [], allowed: [], inventory: [], warnings: [], skipped: [], unscanned: [] };

    function addHit(rule, file, raw, offset) {
        const hit = { rule, file, offset, preview: raw ? mask(raw) : '', raw };
        const entry = findAllowEntry(allowlist, hit);
        if (entry) {
            result.allowed.push({ rule, file, offset, preview: raw ? mask(raw) : '', reason: entry.reason });
            return;
        }
        result.hits.push(hit);
    }

    function checkFilename(display) {
        const parts = display.split('!/').pop().split('/');
        const base = parts[parts.length - 1];
        // .git 只在目录（或 worktree 的 .git 文件）本身报一次，不逐个报里面的文件
        if (base === '.git') addHit('sensitive-filename', display, '.git/', null);
        else if (base.startsWith('._')) addHit('appledouble', display, base, null);
        else if (base === '.DS_Store') addHit('appledouble', display, base, null);
        else if (SENSITIVE_BASENAMES.some(pattern => pattern.test(base))) addHit('sensitive-filename', display, base, null);
    }

    async function scanFile(filePath, display, depth) {
        checkFilename(display);
        const head = readHead(filePath);
        const kind = detectArchiveKind(head);
        // 归档先展开再扫内容；展开成功就只算哈希，不再对归档原始字节重复扫描
        // （否则每个 tar 层里的命中会在“层文件本身”和“解开后的文件”各报一次）
        let expanded = false;
        if (kind) {
            if (depth >= maxDepth) {
                // 嵌套超限：gzip 流式解压扫描内容（不落盘、不再嵌套），其它格式无法检查，计入 unscanned
                if (kind in DECOMPRESSORS) {
                    expanded = kind === 'gzip' ? await scanGunzipped(filePath, display) : await scanDecompressed(filePath, display, kind);
                } else {
                    result.unscanned.push({ file: display, reason: `嵌套层数超过 ${maxDepth}，${kind} 无法展开` });
                }
            } else {
                expanded = await expandArchive(filePath, display, kind, depth);
            }
        }
        const stats = await scanStreamContent(
            fs.createReadStream(filePath, { highWaterMark: CHUNK_BYTES }),
            expanded ? [] : rules,
            (rule, raw, offset) => addHit(rule, display, raw, offset)
        );
        result.inventory.push({ path: display, size: stats.size, sha256: stats.sha256 });
    }

    async function expandArchive(filePath, display, kind, depth) {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-scan-'));
        try {
            const untar = extraArgs => spawnSync('tar', ['-xf', filePath, '-C', dir, ...extraArgs], { encoding: 'utf-8' });
            let extracted = untar(['--no-same-owner', '--no-same-permissions']);
            // 个别 tar 实现（如 macOS bsdtar）不认这两个选项：退回最朴素的解包
            if (extracted.status !== 0 && /nrecognized|nknown option|illegal option|invalid option/i.test(String(extracted.stderr))) {
                extracted = untar([]);
            }
            const entries = fs.readdirSync(dir);
            if (extracted.error || (extracted.status !== 0 && entries.length === 0)) {
                if (kind === 'gzip') {
                    return await scanGunzipped(filePath, display);
                }
                if (kind !== 'tar' && kind in DECOMPRESSORS) {
                    return await scanDecompressed(filePath, display, kind);
                }
                result.unscanned.push({ file: display, reason: kind !== 'tar' ? `无法解开 ${kind} 文件` : 'tar 解包失败' });
                return false;
            }
            if (extracted.status !== 0) {
                result.unscanned.push({ file: display, reason: 'tar 解包不完整，部分内容未扫描' });
            }
            // 解出来的目录可能是 000/只读（容器层里常见），不先放开权限 readdir 会 EACCES
            spawnSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' });
            await walk(dir, `${display}!`, depth + 1);
            return true;
        } finally {
            removeTree(dir);
        }
    }

    // gzip 但不是 tar：解压后的内容同样要扫（不单独列入清单）
    async function scanGunzipped(filePath, display) {
        const gunzip = zlib.createGunzip();
        const input = fs.createReadStream(filePath);
        input.pipe(gunzip);
        try {
            await scanStreamContent(gunzip, rules, (rule, raw, offset) => addHit(rule, `${display}!gunzip`, raw, offset));
            return true;
        } catch (error) {
            result.unscanned.push({ file: display, reason: 'gzip 解压失败' });
            return false;
        }
    }

    // xz/zstd/bzip2 但不是 tar：调用系统解压器，输出流直接扫描（不落盘）
    async function scanDecompressed(filePath, display, kind) {
        const [command, ...args] = DECOMPRESSORS[kind];
        const child = spawn(command, [...args, filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
        const exited = new Promise(resolve => {
            child.on('error', () => resolve(-1));
            child.on('close', code => resolve(code));
        });
        try {
            await scanStreamContent(child.stdout, rules, (rule, raw, offset) => addHit(rule, `${display}!${kind}`, raw, offset));
        } catch (error) {
            child.kill();
        }
        if (await exited !== 0) {
            result.unscanned.push({ file: display, reason: `${kind} 解压失败（系统可能没有 ${command}）` });
            return false;
        }
        return true;
    }

    async function walk(dir, prefix, depth) {
        const names = fs.readdirSync(dir).sort();
        for (const name of names) {
            const fullPath = path.join(dir, name);
            const display = prefix ? `${prefix}/${name}` : name;
            if (isExcluded(display)) {
                result.skipped.push(display);
                continue;
            }
            const stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink()) {
                checkFilename(display);
                result.inventory.push({ path: `${display} -> ${fs.readlinkSync(fullPath)}`, size: 0, sha256: '' });
            } else if (stat.isDirectory()) {
                checkFilename(display);
                await walk(fullPath, display, depth);
            } else if (stat.isFile()) {
                await scanFile(fullPath, display, depth);
            }
        }
    }

    for (const target of targets) {
        if (!fs.existsSync(target)) {
            throw new Error(`扫描目标不存在: ${target}`);
        }
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) {
            await walk(target, path.basename(path.resolve(target)), 1);
        } else {
            await scanFile(target, path.basename(target), 1);
        }
    }

    result.hits.forEach(hit => { delete hit.raw; });
    return result;
}

function autoIdentities() {
    const values = [];
    try { values.push(os.userInfo().username); } catch (e) { /* 无用户信息 */ }
    values.push(os.hostname());
    return values.filter(value => value && value.length >= 4 && !GENERIC_IDENTITIES.has(value.toLowerCase()));
}

function parseArgs(argv) {
    const args = { targets: [], denyStrings: [], excludes: [], allowlistPath: '', json: false, inventory: true, autoIdentity: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--allowlist') args.allowlistPath = argv[++i] || '';
        else if (arg === '--build-user' || arg === '--build-host') args.denyStrings.push(argv[++i] || '');
        else if (arg === '--auto-identity') args.autoIdentity = true;
        else if (arg === '--exclude') {
            const pattern = argv[++i] || '';
            if (!pattern.startsWith('^')) throw new Error(`--exclude 必须以 ^ 锚定（避免误跳过无关路径）: ${pattern}`);
            args.excludes.push(pattern);
        }
        else if (arg === '--json') args.json = true;
        else if (arg === '--no-inventory') args.inventory = false;
        else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
        else args.targets.push(arg);
    }
    if (args.targets.length === 0) throw new Error('请至少指定一个扫描目标（目录或归档）');
    return args;
}

function formatReport(result, printInventory) {
    const lines = [];
    if (result.hits.length === 0) {
        lines.push(result.unscanned.length === 0 ? '扫描通过：没有命中任何规则' : '没有命中规则，但有文件未能扫描');
    } else {
        lines.push(`发现 ${result.hits.length} 处命中（内容已截断显示）:`);
        result.hits.forEach(hit => {
            const where = hit.offset === null ? '' : ` @${hit.offset}`;
            lines.push(`  [${hit.rule}] ${hit.file}${where}${hit.preview ? `  ${hit.preview}` : ''}`);
        });
    }
    if (result.unscanned.length > 0) {
        lines.push(`未能扫描 ${result.unscanned.length} 个文件（按失败处理）:`);
        result.unscanned.slice(0, 20).forEach(item => lines.push(`  ${item.file}  (${item.reason})`));
    }
    if (result.allowed.length > 0) lines.push(`允许列表放行 ${result.allowed.length} 处`);
    // 镜像里成千上万个 .gz（changelog 等）会触发“嵌套过深”告警，合并成一行，其余原样列出
    const deepWarnings = result.warnings.filter(warning => warning.startsWith('嵌套层数超过'));
    if (deepWarnings.length > 0) lines.push(`警告: ${deepWarnings.length} 个文件嵌套层数超过上限未展开（例: ${deepWarnings[0].split(': ').slice(1).join(': ')}）`);
    result.warnings.filter(warning => !warning.startsWith('嵌套层数超过')).forEach(warning => lines.push(`警告: ${warning}`));
    if (result.skipped.length > 0) lines.push(`按 --exclude 跳过 ${result.skipped.length} 项: ${result.skipped.slice(0, 5).join(', ')}`);
    if (printInventory) {
        lines.push('', '产物清单 (sha256  大小  路径):');
        result.inventory.forEach(item => lines.push(`  ${item.sha256 || '-'.repeat(64)}  ${item.size}  ${item.path}`));
    }
    return lines.join('\n');
}

async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
        const allowlist = args.allowlistPath ? JSON.parse(fs.readFileSync(args.allowlistPath, 'utf-8')) : [];
        const denyStrings = [...args.denyStrings, ...(args.autoIdentity ? autoIdentities() : [])];
        const result = await scanTargets(args.targets, { denyStrings, allowlist, excludes: args.excludes });
        console.log(args.json ? JSON.stringify(result, null, 2) : formatReport(result, args.inventory));
        return result.hits.length === 0 && result.unscanned.length === 0 ? 0 : 1;
    } catch (error) {
        console.error(`扫描失败: ${error.message}`);
        if (error.stack) console.error(error.stack);
        return 2;
    }
}

module.exports = {
    scanTargets,
    mask,
    detectArchiveKind,
    validateAllowlist,
    parseArgs
};

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code));
}
