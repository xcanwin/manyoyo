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
const { spawnSync } = require('child_process');

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
    const tmpRoot = options.tmpRoot || os.tmpdir();
    const result = { hits: [], allowed: [], inventory: [], warnings: [] };

    function addHit(rule, file, raw, offset) {
        const hit = { rule, file, offset, preview: raw ? mask(raw) : '', raw };
        const entry = findAllowEntry(allowlist, hit);
        if (entry) {
            result.allowed.push({ rule, file, offset, reason: entry.reason });
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
        const stats = await scanStreamContent(
            fs.createReadStream(filePath, { highWaterMark: CHUNK_BYTES }),
            rules,
            (rule, raw, offset) => addHit(rule, display, raw, offset)
        );
        result.inventory.push({ path: display, size: stats.size, sha256: stats.sha256 });

        if (!kind) return;
        if (depth >= maxDepth) {
            result.warnings.push(`嵌套层数超过 ${maxDepth}，未展开: ${display}`);
            return;
        }
        await expandArchive(filePath, display, kind, depth);
    }

    async function expandArchive(filePath, display, kind, depth) {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-scan-'));
        try {
            const extracted = spawnSync('tar', ['-xf', filePath, '-C', dir, '--no-same-owner', '--no-same-permissions'], {
                encoding: 'utf-8'
            });
            const entries = fs.readdirSync(dir);
            if (extracted.error || (extracted.status !== 0 && entries.length === 0)) {
                if (kind === 'gzip') {
                    await scanGunzipped(filePath, display);
                } else if (kind !== 'tar') {
                    result.warnings.push(`无法解开 ${kind} 文件，仅按原始字节扫描: ${display}`);
                } else {
                    result.warnings.push(`tar 解包失败: ${display}`);
                }
                return;
            }
            if (extracted.status !== 0) {
                result.warnings.push(`tar 解包有告警（已尽量解开）: ${display}`);
            }
            await walk(dir, `${display}!`, depth + 1);
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
        } catch (error) {
            result.warnings.push(`gzip 解压失败: ${display}`);
        }
    }

    async function walk(dir, prefix, depth) {
        const names = fs.readdirSync(dir).sort();
        for (const name of names) {
            const fullPath = path.join(dir, name);
            const display = prefix ? `${prefix}/${name}` : name;
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
    const args = { targets: [], denyStrings: [], allowlistPath: '', json: false, inventory: true, autoIdentity: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--allowlist') args.allowlistPath = argv[++i] || '';
        else if (arg === '--build-user' || arg === '--build-host') args.denyStrings.push(argv[++i] || '');
        else if (arg === '--auto-identity') args.autoIdentity = true;
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
        lines.push('扫描通过：没有命中任何规则');
    } else {
        lines.push(`发现 ${result.hits.length} 处命中（内容已截断显示）:`);
        result.hits.forEach(hit => {
            const where = hit.offset === null ? '' : ` @${hit.offset}`;
            lines.push(`  [${hit.rule}] ${hit.file}${where}${hit.preview ? `  ${hit.preview}` : ''}`);
        });
    }
    if (result.allowed.length > 0) lines.push(`允许列表放行 ${result.allowed.length} 处`);
    result.warnings.forEach(warning => lines.push(`警告: ${warning}`));
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
        const result = await scanTargets(args.targets, { denyStrings, allowlist });
        console.log(args.json ? JSON.stringify(result, null, 2) : formatReport(result, args.inventory));
        return result.hits.length === 0 ? 0 : 1;
    } catch (error) {
        console.error(`扫描失败: ${error.message}`);
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
