'use strict';

// “改动”视图：在容器里对工作目录所在的 git 仓库跑只读命令（status / diff），按需执行、不轮询。
// 仓库内容和 git 配置都由容器内进程控制，按不可信输入处理：关掉会执行外部程序的配置
//（外部 diff、textconv、fsmonitor），不写 index（GIT_OPTIONAL_LOCKS=0），输出有上限。

const CHANGES_MAX_FILES = 500;
const DIFF_MAX_BYTES = 512 * 1024;
const GIT_TIMEOUT_SECONDS = 10;
const STATUS_MARK = '__MANYOYO_GIT_STATUS__';
const NUMSTAT_MARK = '__MANYOYO_GIT_NUMSTAT__';
const ROOT_MARK = '__MANYOYO_GIT_ROOT__';

function quote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const GIT = `GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 timeout ${GIT_TIMEOUT_SECONDS} git -c core.quotepath=off -c core.fsmonitor=false -c diff.external= -c color.ui=false`;

// 进到工作目录所在仓库的根目录；不是仓库时只输出一行 NOT_REPO
function enterRepo(workDir) {
    return [
        `cd -- ${quote(workDir || '/')} 2>/dev/null || { echo NOT_REPO; exit 0; }`,
        `top="$(${GIT} rev-parse --show-toplevel 2>/dev/null)" || { echo NOT_REPO; exit 0; }`,
        'cd -- "$top" || { echo NOT_REPO; exit 0; }'
    ].join('; ');
}

function buildGitChangesCommand(workDir) {
    return [
        enterRepo(workDir),
        `printf '%s\\n%s\\n' ${ROOT_MARK} "$top"`,
        `printf '%s\\n' ${STATUS_MARK}`,
        `${GIT} status --porcelain=v1 -z --no-renames --untracked-files=all 2>/dev/null | head -c 1048576`,
        `printf '\\n%s\\n' ${NUMSTAT_MARK}`,
        `if ${GIT} rev-parse --verify -q HEAD >/dev/null 2>&1; then ${GIT} diff HEAD --numstat -z --no-renames --no-ext-diff --no-textconv 2>/dev/null | head -c 1048576; fi`
    ].join('; ');
}

function sectionAfter(output, mark, nextMark) {
    const start = output.indexOf(`${mark}\n`);
    if (start < 0) return '';
    const from = start + mark.length + 1;
    const end = nextMark ? output.indexOf(`\n${nextMark}\n`, from) : -1;
    return end < 0 ? output.slice(from) : output.slice(from, end);
}

function parseGitChangesOutput(output) {
    const text = String(output || '');
    if (!text.includes(ROOT_MARK)) {
        return { repo: false, root: '', files: [], truncated: false };
    }
    const root = sectionAfter(text, ROOT_MARK, STATUS_MARK).split('\n')[0].trim();
    const statusPart = sectionAfter(text, STATUS_MARK, NUMSTAT_MARK);
    const numstatPart = sectionAfter(text, NUMSTAT_MARK, '');
    const counts = new Map();
    for (const record of numstatPart.split('\0')) {
        const match = record.replace(/^\n/, '').match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
        if (match) {
            counts.set(match[3], {
                added: match[1] === '-' ? null : Number(match[1]),
                deleted: match[2] === '-' ? null : Number(match[2])
            });
        }
    }
    const files = [];
    let truncated = false;
    for (const record of statusPart.split('\0')) {
        if (record.length < 4 || record[2] !== ' ') continue;
        const code = record.slice(0, 2);
        const filePath = record.slice(3);
        if (!filePath || filePath.includes('\n')) continue;
        if (files.length >= CHANGES_MAX_FILES) {
            truncated = true;
            break;
        }
        const count = counts.get(filePath) || { added: null, deleted: null };
        files.push({ path: filePath, status: code === '??' ? 'untracked' : describeStatus(code), ...count });
    }
    return { repo: true, root, files, truncated };
}

function describeStatus(code) {
    if (code.includes('D')) return 'deleted';
    if (code.includes('A')) return 'added';
    if (code.includes('U')) return 'conflicted';
    return 'modified';
}

function isAcceptableDiffPath(filePath) {
    return typeof filePath === 'string'
        && filePath.length > 0
        && filePath.length <= 4096
        && !filePath.startsWith('-')
        && !filePath.includes('\0')
        && !filePath.includes('\n');
}

function buildGitDiffCommand(workDir, filePath) {
    return [
        enterRepo(workDir),
        `printf '%s\\n' ${STATUS_MARK}`,
        `if ${GIT} rev-parse --verify -q HEAD >/dev/null 2>&1; then base=HEAD; else base=; fi`,
        `${GIT} diff $base --no-ext-diff --no-textconv --no-color --no-renames -- ${quote(filePath)} 2>/dev/null | head -c ${DIFF_MAX_BYTES + 1}`
    ].join('; ');
}

function parseGitDiffOutput(output) {
    const text = String(output || '');
    if (!text.includes(STATUS_MARK)) {
        return { repo: false, diff: '', truncated: false };
    }
    const body = sectionAfter(text, STATUS_MARK, '');
    const truncated = Buffer.byteLength(body, 'utf8') > DIFF_MAX_BYTES;
    return {
        repo: true,
        diff: truncated ? Buffer.from(body, 'utf8').subarray(0, DIFF_MAX_BYTES).toString('utf8') : body,
        truncated
    };
}

module.exports = {
    CHANGES_MAX_FILES,
    DIFF_MAX_BYTES,
    buildGitChangesCommand,
    parseGitChangesOutput,
    buildGitDiffCommand,
    parseGitDiffOutput,
    isAcceptableDiffPath
};
