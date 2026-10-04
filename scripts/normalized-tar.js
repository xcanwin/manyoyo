'use strict';

// 规范化打包：不带属主用户名/组名、固定 mtime、无扩展属性、剔除 ._* 与 .DS_Store，
// 这样 tar 本身不会泄露构建机信息，同样输入也能得到可复现的结果。供离线包组装（T08）使用。

const { spawnSync } = require('child_process');

const DEFAULT_MTIME = '2020-01-01T00:00:00Z';
const EXCLUDES = ['._*', '.DS_Store'];

// 默认用 PATH 里的 tar；macOS 自带 bsdtar 缺 --mtime/--sort，CI 里用 MANYOYO_TAR 指向 GNU tar 以获得可复现的归档
function tarBinary() {
    return process.env.MANYOYO_TAR || 'tar';
}

function detectTarFlavor(tarBin = tarBinary()) {
    const result = spawnSync(tarBin, ['--version'], { encoding: 'utf-8' });
    const text = `${result.stdout || ''}${result.stderr || ''}`;
    if (/bsdtar|libarchive/i.test(text)) return 'bsd';
    return 'gnu';
}

function compressionArgs(compression, flavor) {
    if (!compression || compression === 'none') return [];
    if (compression === 'gzip') {
        // gzip -n：不写入文件名和时间戳
        return flavor === 'gnu' ? ['--use-compress-program', 'gzip -n'] : ['--gzip'];
    }
    if (compression === 'gzip-fast') {
        // 内容大多已是压缩文件（镜像归档、VM 磁盘），默认级别白费 CPU：用 -1，解包端仍是普通 tar -xzf
        return flavor === 'gnu' ? ['--use-compress-program', 'gzip -n -1'] : ['--gzip', '--options', 'gzip:compression-level=1'];
    }
    if (compression === 'xz') return ['--xz'];
    throw new Error(`不支持的压缩方式: ${compression}`);
}

/**
 * 生成规范化 tar 命令参数（不执行）。
 * @param {{output: string, cwd: string, entries: string[], mtime?: string, compression?: 'none'|'gzip'|'xz', flavor?: 'gnu'|'bsd'}} options
 */
function buildNormalizedTarArgs(options) {
    const { output, entries } = options;
    if (!output) throw new Error('缺少 output');
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries 不能为空');
    const flavor = options.flavor || detectTarFlavor();
    const mtime = options.mtime || DEFAULT_MTIME;
    const args = ['-c', '-f', output];
    if (flavor === 'gnu') {
        args.push(
            '--owner=0', '--group=0', '--numeric-owner',
            `--mtime=${mtime}`,
            '--sort=name',
            '--format=gnu',
            '--no-xattrs', '--no-acls', '--no-selinux'
        );
    } else {
        args.push(
            '--uid', '0', '--gid', '0', '--uname', '', '--gname', '',
            '--numeric-owner',
            '--no-xattrs', '--no-mac-metadata'
        );
    }
    EXCLUDES.forEach(pattern => args.push(`--exclude=${pattern}`));
    args.push(...compressionArgs(options.compression, flavor));
    args.push('-C', options.cwd, ...entries);
    return { flavor, args };
}

function createNormalizedTar(options) {
    const { flavor, args } = buildNormalizedTarArgs(options);
    const result = spawnSync(tarBinary(), args, {
        encoding: 'utf-8',
        // macOS 的 tar 会把资源派生文件打成 ._*，COPYFILE_DISABLE 从源头关掉
        env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
    if (result.error || result.status !== 0) {
        throw new Error(`tar 打包失败: ${result.error ? result.error.message : (result.stderr || '').trim()}`);
    }
    return { flavor, output: options.output };
}

module.exports = {
    DEFAULT_MTIME,
    detectTarFlavor,
    buildNormalizedTarArgs,
    createNormalizedTar
};
