(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.ManyoyoPathPickerUtils = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalizeSlashPath(value) {
        return String(value || '').replace(/\\/g, '/');
    }

    function isChildPath(basePath, targetPath) {
        const normalizedBase = normalizeSlashPath(basePath).replace(/\/+$/, '');
        const normalizedTarget = normalizeSlashPath(targetPath).replace(/\/+$/, '');
        if (!normalizedBase) {
            return false;
        }
        return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + '/');
    }

    function resolveContainerPickerBase(baseContainerPath, currentContainerPath) {
        return String(baseContainerPath || '').trim()
            || String(currentContainerPath || '').trim()
            || '/workspace';
    }

    function buildContainerPathFromHostSelection(baseHostPath, baseContainerPath, selectedHostPath) {
        const normalizedBaseHost = normalizeSlashPath(baseHostPath).replace(/\/+$/, '');
        const normalizedContainer = normalizeSlashPath(baseContainerPath).replace(/\/+$/, '') || '/workspace';
        const normalizedSelected = normalizeSlashPath(selectedHostPath).replace(/\/+$/, '');
        if (!normalizedBaseHost || !isChildPath(normalizedBaseHost, normalizedSelected)) {
            return normalizedContainer;
        }
        const relative = normalizedSelected === normalizedBaseHost
            ? ''
            : normalizedSelected.slice(normalizedBaseHost.length + 1);
        return relative ? `${normalizedContainer}/${relative}`.replace(/\/+/g, '/') : normalizedContainer;
    }

    function applyContainerPathSelection(baseHostPath, baseContainerPath, currentContainerPath, selectedHostPath) {
        return buildContainerPathFromHostSelection(
            baseHostPath,
            resolveContainerPickerBase(baseContainerPath, currentContainerPath),
            selectedHostPath
        );
    }

    return {
        normalizeSlashPath,
        isChildPath,
        resolveContainerPickerBase,
        buildContainerPathFromHostSelection,
        applyContainerPathSelection
    };
}));
