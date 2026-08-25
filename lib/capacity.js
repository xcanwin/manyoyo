'use strict';

// 新容器主要复用镜像的只读层（overlayfs），没有历史容器数据可参考时，
// 按这个偏保守的写层体积假设估算——避免刚起步就把估算数拉得虚高
const DEFAULT_FALLBACK_CONTAINER_BYTES = 100 * 1024 * 1024;

function toPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function estimateContainerCapacity(options = {}) {
    const runCommand = typeof options.runCommand === 'function'
        ? options.runCommand
        : () => { throw new Error('未配置命令执行器'); };
    const statfs = typeof options.statfs === 'function'
        ? options.statfs
        : () => { throw new Error('未配置磁盘空间检测器'); };

    const runtimeCommand = options.runtimeCommand || 'docker';
    const imageRef = `${options.imageName || ''}:${options.imageVersion || ''}`;
    const containerNames = Array.isArray(options.containerNames) ? options.containerNames : [];
    const diskPath = options.diskPath || '';
    const notes = [];

    let imageSizeBytes = 0;
    try {
        const raw = runCommand(runtimeCommand, ['image', 'inspect', imageRef, '--format', '{{.Size}}']);
        imageSizeBytes = toPositiveNumber(String(raw).trim().split('\n')[0]);
    } catch (error) {
        notes.push(`镜像 ${imageRef} 尚未在本地构建/拉取，暂无法读取体积。`);
    }

    let averageWritableBytes = 0;
    let sampledCount = 0;
    if (containerNames.length > 0) {
        try {
            const raw = runCommand(runtimeCommand, ['inspect', '--size', '--format', '{{.SizeRw}}', ...containerNames]);
            const sizes = String(raw)
                .split('\n')
                .map(line => toPositiveNumber(line.trim()))
                .filter(size => size > 0);
            if (sizes.length > 0) {
                averageWritableBytes = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
                sampledCount = sizes.length;
            }
        } catch (error) {
            notes.push('无法读取现有容器的可写层体积，改用保守默认值估算。');
        }
    }

    const perContainerEstimateBytes = averageWritableBytes > 0 ? averageWritableBytes : DEFAULT_FALLBACK_CONTAINER_BYTES;
    if (sampledCount === 0) {
        notes.push(`当前没有可参考的历史容器数据，按 ${Math.round(DEFAULT_FALLBACK_CONTAINER_BYTES / (1024 * 1024))}MB / 容器的保守假设估算。`);
    }

    let availableBytes = 0;
    try {
        const stat = statfs(diskPath);
        availableBytes = toPositiveNumber(stat.bavail) * toPositiveNumber(stat.bsize);
    } catch (error) {
        notes.push('无法读取宿主机磁盘剩余空间。');
    }

    const estimatedAdditionalContainers = perContainerEstimateBytes > 0 && availableBytes > 0
        ? Math.max(0, Math.floor(availableBytes / perContainerEstimateBytes))
        : null;

    notes.push('新容器主要复用镜像的只读层，磁盘增量主要来自容器自身的可写层；这里按现有容器可写层的平均值估算，实际会随使用情况波动，仅供参考。');

    return {
        runtimeCommand,
        image: {
            reference: imageRef,
            sizeBytes: imageSizeBytes || null
        },
        container: {
            averageWritableBytes: Math.round(perContainerEstimateBytes),
            sampledCount
        },
        disk: {
            path: diskPath,
            availableBytes: availableBytes || null
        },
        estimatedAdditionalContainers,
        notes
    };
}

module.exports = {
    estimateContainerCapacity
};
