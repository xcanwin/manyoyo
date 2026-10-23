'use strict';

// 按轮快照与回退：每轮对话前后，在容器里对工作目录各拍一次“影子 git”快照
//（--git-dir 放在容器能写的 /run/manyoyo/snap.git，--work-tree 指向工作目录），不碰用户自己的 .git。
// 这是体验功能，不是安全边界：快照在容器里，agent 能改它（和 Claude 自己的检查点一样）。
// 会读工作目录里的 .gitignore（node_modules 等不进快照）；单次超过 SNAPSHOT_TIMEOUT_SECONDS 就放弃，本轮不能回退文件。
// 所有命令都是 bash 脚本字符串，路径 / 提交号一律经 quote() 或校验后才拼进去。

const SNAP_GIT_DIR = '/run/manyoyo/snap.git';
const SNAPSHOT_TIMEOUT_SECONDS = 3;
const GIT_TIMEOUT_SECONDS = 10;
const ROUND_CHANGES_MAX_FILES = 500;
const ROUND_DIFF_MAX_BYTES = 512 * 1024;
const PREVIEW_FILE_LIMIT = 20;
const MARK_SHA = '__MANYOYO_SNAP_SHA__';
const MARK_RAW = '__MANYOYO_SNAP_RAW__';
const MARK_NUMSTAT = '__MANYOYO_SNAP_NUMSTAT__';
const MARK_DIFF = '__MANYOYO_SNAP_DIFF__';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function isSnapId(value) {
    return typeof value === 'string' && SHA_PATTERN.test(value);
}

function quote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function assertSnap(value, label) {
    if (!isSnapId(value)) throw new Error(`${label} 不是合法的快照号`);
    return value;
}

// 提交说明只留安全字符
function safeLabel(label) {
    return String(label || 'snapshot').replace(/[^A-Za-z0-9 _.:-]/g, '').slice(0, 80) || 'snapshot';
}

// 公共前缀：影子仓库的 git 命令。配置不读用户的；hooks / gc / fsmonitor 全关
function prelude(workDir, gitDir) {
    return [
        `W=${quote(workDir)}`,
        `G=${quote(gitDir)}`,
        'cd -- "$W" 2>/dev/null || { echo SKIP_NO_DIR; exit 0; }',
        'export GIT_DIR="$G" GIT_WORK_TREE="$W" GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
        'export GIT_CONFIG_COUNT=9',
        'export GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=manyoyo',
        'export GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=manyoyo@localhost',
        'export GIT_CONFIG_KEY_2=safe.directory GIT_CONFIG_VALUE_2="*"',
        'export GIT_CONFIG_KEY_3=core.excludesFile GIT_CONFIG_VALUE_3=/dev/null',
        'export GIT_CONFIG_KEY_4=gc.auto GIT_CONFIG_VALUE_4=0',
        'export GIT_CONFIG_KEY_5=core.hooksPath GIT_CONFIG_VALUE_5=/dev/null',
        'export GIT_CONFIG_KEY_6=core.fsmonitor GIT_CONFIG_VALUE_6=false',
        'export GIT_CONFIG_KEY_7=core.quotepath GIT_CONFIG_VALUE_7=false',
        'export GIT_CONFIG_KEY_8=commit.gpgsign GIT_CONFIG_VALUE_8=false'
    ].join('; ');
}

// 拍快照的步骤（不含 prelude）：输出 SNAP_SHA 行；超时输出 SNAP_TIMEOUT
function snapshotSteps(label) {
    return [
        '[ -d "$G" ] || env -u GIT_DIR -u GIT_WORK_TREE git init -q --bare "$G" >/dev/null 2>&1 || { echo SNAP_FAIL; exit 0; }',
        'rm -f "$G/index.lock"',
        `timeout -k 1 ${SNAPSHOT_TIMEOUT_SECONDS} git add -A >/dev/null 2>&1; rc=$?`,
        '[ "$rc" = 124 ] || [ "$rc" = 137 ] && { rm -f "$G/index.lock"; echo SNAP_TIMEOUT; exit 0; }',
        // add 失败（比如有读不了的文件）时不能继续：否则 HEAD 还是上一张快照，会被当成“现在”的快照记下来
        '[ "$rc" = 0 ] || { echo SNAP_FAIL; exit 0; }',
        `timeout -k 1 ${SNAPSHOT_TIMEOUT_SECONDS} git commit -q --allow-empty --no-verify -m ${quote(safeLabel(label))} >/dev/null 2>&1; rc=$?`,
        '[ "$rc" = 124 ] || [ "$rc" = 137 ] && { rm -f "$G/index.lock"; echo SNAP_TIMEOUT; exit 0; }',
        '[ "$rc" = 0 ] || { echo SNAP_FAIL; exit 0; }',
        `sha="$(git rev-parse HEAD 2>/dev/null)" || { echo SNAP_FAIL; exit 0; }`,
        `printf '%s\\n%s\\n' ${MARK_SHA} "$sha"`
    ];
}

function buildSnapshotCommand(workDir, label, gitDir = SNAP_GIT_DIR) {
    return [prelude(workDir, gitDir), ...snapshotSteps(label)].join('; ');
}

/** @returns {{sha: string}|{skipped: 'too-large'|'unavailable'}} */
function parseSnapshotOutput(output) {
    const text = String(output || '');
    if (text.includes('SNAP_TIMEOUT')) return { skipped: 'too-large' };
    const match = text.match(new RegExp(`${MARK_SHA}\\n([0-9a-f]{40})`));
    return match ? { sha: match[1] } : { skipped: 'unavailable' };
}

// ---- 比较两个快照 ----

function diffSteps(from, to) {
    const a = assertSnap(from, 'from');
    const b = assertSnap(to, 'to');
    return [
        `printf '%s\\n' ${MARK_RAW}`,
        `timeout ${GIT_TIMEOUT_SECONDS} git diff --name-status -z --no-renames --no-ext-diff --no-textconv ${a} ${b} 2>/dev/null | head -c 1048576`,
        `printf '\\n%s\\n' ${MARK_NUMSTAT}`,
        `timeout ${GIT_TIMEOUT_SECONDS} git diff --numstat -z --no-renames --no-ext-diff --no-textconv ${a} ${b} 2>/dev/null | head -c 1048576`
    ];
}

function sectionAfter(output, mark, nextMark) {
    const start = output.indexOf(`${mark}\n`);
    if (start < 0) return '';
    const from = start + mark.length + 1;
    const end = nextMark ? output.indexOf(`\n${nextMark}\n`, from) : -1;
    return end < 0 ? output.slice(from) : output.slice(from, end);
}

function parseNameStatus(raw) {
    const parts = raw.split('\0');
    const entries = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const code = parts[i].replace(/^\n/, '');
        const filePath = parts[i + 1];
        if (!code || !filePath || filePath.includes('\n')) continue;
        entries.push({ code: code[0], path: filePath });
    }
    return entries;
}

function statusOf(code) {
    return code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
}

function buildRoundChangesCommand(workDir, from, to, gitDir = SNAP_GIT_DIR) {
    return [prelude(workDir, gitDir), `[ -d "$G" ] || { echo SNAP_FAIL; exit 0; }`, ...diffSteps(from, to)].join('; ');
}

function parseRoundChangesOutput(output) {
    const text = String(output || '');
    if (!text.includes(MARK_RAW)) return { ok: false, files: [], truncated: false };
    const counts = new Map();
    for (const record of sectionAfter(text, MARK_NUMSTAT, '').split('\0')) {
        const match = record.replace(/^\n/, '').match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
        if (match) counts.set(match[3], { added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]) });
    }
    const entries = parseNameStatus(sectionAfter(text, MARK_RAW, MARK_NUMSTAT));
    const files = entries.slice(0, ROUND_CHANGES_MAX_FILES).map(entry => ({
        path: entry.path,
        status: statusOf(entry.code),
        ...(counts.get(entry.path) || { added: null, deleted: null })
    }));
    return { ok: true, files, truncated: entries.length > ROUND_CHANGES_MAX_FILES };
}

function buildRoundDiffCommand(workDir, from, to, filePath, gitDir = SNAP_GIT_DIR) {
    const a = assertSnap(from, 'from');
    const b = assertSnap(to, 'to');
    return [
        prelude(workDir, gitDir),
        `[ -d "$G" ] || { echo SNAP_FAIL; exit 0; }`,
        `printf '%s\\n' ${MARK_DIFF}`,
        `GIT_LITERAL_PATHSPECS=1 timeout ${GIT_TIMEOUT_SECONDS} git diff --no-ext-diff --no-textconv --no-color --no-renames ${a} ${b} -- ${quote(filePath)} 2>/dev/null | head -c ${ROUND_DIFF_MAX_BYTES + 1}`
    ].join('; ');
}

function parseRoundDiffOutput(output) {
    const text = String(output || '');
    if (!text.includes(MARK_DIFF)) return { ok: false, diff: '', truncated: false };
    const body = sectionAfter(text, MARK_DIFF, '');
    const truncated = Buffer.byteLength(body, 'utf8') > ROUND_DIFF_MAX_BYTES;
    return { ok: true, diff: truncated ? Buffer.from(body, 'utf8').subarray(0, ROUND_DIFF_MAX_BYTES).toString('utf8') : body, truncated };
}

// ---- 回退文件 ----

// 先拍一张“现在”的快照，再看它和目标快照差在哪：M 会被改回去，A（目标之后新增）会被删掉，D（目标之后被删）会被恢复
function buildRestorePreviewCommand(workDir, target, gitDir = SNAP_GIT_DIR) {
    const t = assertSnap(target, 'target');
    return [
        prelude(workDir, gitDir),
        `[ -d "$G" ] || { echo SNAP_FAIL; exit 0; }`,
        ...snapshotSteps('rewind preview'),
        `printf '%s\\n' ${MARK_RAW}`,
        `timeout ${GIT_TIMEOUT_SECONDS} git diff --name-status -z --no-renames --no-ext-diff --no-textconv ${t} "$sha" 2>/dev/null | head -c 1048576`
    ].join('; ');
}

function parseRestorePreviewOutput(output) {
    const text = String(output || '');
    const snap = parseSnapshotOutput(text);
    if (!snap.sha || !text.includes(MARK_RAW)) return { ok: false, reason: snap.skipped || 'unavailable' };
    const entries = parseNameStatus(sectionAfter(text, MARK_RAW, ''));
    const count = code => entries.filter(entry => entry.code === code).length;
    // 目标 → 现在：A 是目标之后新增的（要删），D 是目标之后删掉的（要恢复），其余算修改
    const files = entries.slice(0, PREVIEW_FILE_LIMIT).map(entry => ({
        path: entry.path,
        action: entry.code === 'A' ? 'delete' : entry.code === 'D' ? 'restore' : 'modify'
    }));
    return { ok: true, current: snap.sha, total: entries.length, modify: entries.length - count('A') - count('D'), delete: count('A'), restore: count('D'), files };
}

// 回退前先拍快照（这样回退本身也能撤销），再把工作目录恢复成目标快照：
// 目标里有的文件改回去，“现在有、目标里没有”的文件删掉；被 .gitignore 忽略的文件不动
function buildRestoreCommand(workDir, target, gitDir = SNAP_GIT_DIR) {
    const t = assertSnap(target, 'target');
    return [
        prelude(workDir, gitDir),
        `[ -d "$G" ] || { echo SNAP_FAIL; exit 0; }`,
        ...snapshotSteps('before rewind'),
        // 目标快照里有而现在被改了的文件
        `git cat-file -e ${t}^{commit} 2>/dev/null || { echo RESTORE_FAIL; exit 0; }`,
        // 目标是空目录的快照（第一轮开始前工作目录里什么都没有）时没有文件可检出，`checkout -- .` 会报 pathspec 不匹配，直接跳过
        `if [ -n "$(git ls-tree -r --name-only ${t} 2>/dev/null | head -c 1)" ]; then timeout ${GIT_TIMEOUT_SECONDS * 6} git checkout -q ${t} -- . 2>/dev/null || { echo RESTORE_FAIL; exit 0; }; fi`,
        // 目标之后新增的文件：影子仓库容器能写，路径不可信——绝对路径和带 .. 的一律跳过
        `git diff -z --name-only --diff-filter=A --no-renames ${t} "$sha" 2>/dev/null | while IFS= read -r -d '' f; do case "$f" in /*|..|../*|*/../*|*/..) continue;; esac; rm -f -- "$f"; done`,
        'echo RESTORE_OK'
    ].join('; ');
}

function parseRestoreOutput(output) {
    const text = String(output || '');
    const snap = parseSnapshotOutput(text);
    if (!text.includes('RESTORE_OK')) return { ok: false, reason: snap.skipped || 'failed' };
    return { ok: true, before: snap.sha || '' };
}

module.exports = {
    SNAP_GIT_DIR,
    SNAPSHOT_TIMEOUT_SECONDS,
    isSnapId,
    buildSnapshotCommand,
    parseSnapshotOutput,
    buildRoundChangesCommand,
    parseRoundChangesOutput,
    buildRoundDiffCommand,
    parseRoundDiffOutput,
    buildRestorePreviewCommand,
    parseRestorePreviewOutput,
    buildRestoreCommand,
    parseRestoreOutput
};
