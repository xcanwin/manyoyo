'use strict';

const { app } = require('electron');

function normalizeFeedUrl(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    return text.endsWith('/') ? text : `${text}/`;
}

function createAutoUpdateController() {
    let updater = null;
    let status = {
        enabled: false,
        canCheck: false,
        canDownload: false,
        canInstall: false,
        checking: false,
        downloading: false,
        label: '自动更新未配置',
        detail: '设置 MANYOYO_ELECTRON_UPDATE_URL 后可启用自动更新。',
        feedUrl: '',
        version: app.getVersion()
    };
    let listeners = [];

    function emit() {
        listeners.slice().forEach(function (listener) {
            try {
                listener(Object.assign({}, status));
            } catch (error) {
                // 忽略状态监听异常，避免影响主流程
            }
        });
    }

    function setStatus(nextPartial) {
        status = Object.assign({}, status, nextPartial);
        emit();
    }

    function loadUpdater() {
        if (updater !== null) {
            return updater;
        }
        try {
            const pkg = require('electron-updater');
            updater = pkg && pkg.autoUpdater ? pkg.autoUpdater : null;
        } catch (error) {
            updater = null;
            setStatus({
                enabled: false,
                canCheck: false,
                label: '自动更新不可用',
                detail: 'electron-updater 未安装或当前环境不可用。'
            });
        }
        return updater;
    }

    function configure() {
        const feedUrl = normalizeFeedUrl(process.env.MANYOYO_ELECTRON_UPDATE_URL);
        if (!feedUrl) {
            emit();
            return;
        }

        const autoUpdater = loadUpdater();
        if (!autoUpdater) {
            return;
        }

        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.allowPrerelease = false;
        autoUpdater.allowDowngrade = false;
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: feedUrl,
            channel: String(process.env.MANYOYO_ELECTRON_UPDATE_CHANNEL || 'latest').trim() || 'latest'
        });

        autoUpdater.on('checking-for-update', function () {
            setStatus({
                enabled: true,
                canCheck: false,
                checking: true,
                downloading: false,
                label: '正在检查更新',
                detail: `当前版本 ${status.version}，正在检查远端更新。`,
                feedUrl
            });
        });

        autoUpdater.on('update-available', function (info) {
            const nextVersion = info && info.version ? String(info.version) : '未知版本';
            setStatus({
                enabled: true,
                canCheck: true,
                canDownload: true,
                canInstall: false,
                checking: false,
                downloading: false,
                label: `发现新版本 ${nextVersion}`,
                detail: '可手动下载更新包，下载完成后支持重启安装。',
                feedUrl
            });
        });

        autoUpdater.on('update-not-available', function () {
            setStatus({
                enabled: true,
                canCheck: true,
                canDownload: false,
                canInstall: false,
                checking: false,
                downloading: false,
                label: '当前已是最新版本',
                detail: `当前版本 ${status.version} 已是最新。`,
                feedUrl
            });
        });

        autoUpdater.on('download-progress', function (progress) {
            const percent = progress && typeof progress.percent === 'number'
                ? `${progress.percent.toFixed(1)}%`
                : '已开始';
            setStatus({
                enabled: true,
                canCheck: false,
                canDownload: false,
                canInstall: false,
                checking: false,
                downloading: true,
                label: `正在下载更新 ${percent}`,
                detail: '更新下载完成后可直接重启安装。',
                feedUrl
            });
        });

        autoUpdater.on('update-downloaded', function (info) {
            const nextVersion = info && info.version ? String(info.version) : '新版本';
            setStatus({
                enabled: true,
                canCheck: true,
                canDownload: false,
                canInstall: true,
                checking: false,
                downloading: false,
                label: `${nextVersion} 已下载`,
                detail: '可从菜单执行“安装已下载更新”。',
                feedUrl
            });
        });

        autoUpdater.on('error', function (error) {
            const message = error && error.message ? error.message : String(error);
            setStatus({
                enabled: true,
                canCheck: true,
                canDownload: false,
                canInstall: false,
                checking: false,
                downloading: false,
                label: '自动更新检查失败',
                detail: message,
                feedUrl
            });
        });

        setStatus({
            enabled: true,
            canCheck: true,
            label: '自动更新待检查',
            detail: `已配置更新地址 ${feedUrl}`,
            feedUrl
        });
    }

    async function checkForUpdates() {
        const autoUpdater = loadUpdater();
        if (!status.enabled || !autoUpdater) {
            throw new Error(status.detail);
        }
        await autoUpdater.checkForUpdates();
        return getStatus();
    }

    async function downloadUpdate() {
        const autoUpdater = loadUpdater();
        if (!status.enabled || !autoUpdater) {
            throw new Error(status.detail);
        }
        if (!status.canDownload) {
            throw new Error('当前没有可下载的新版本。');
        }
        await autoUpdater.downloadUpdate();
        return getStatus();
    }

    function quitAndInstall() {
        const autoUpdater = loadUpdater();
        if (!status.enabled || !autoUpdater || !status.canInstall) {
            throw new Error('当前没有已下载完成的更新。');
        }
        autoUpdater.quitAndInstall();
    }

    function getStatus() {
        return Object.assign({}, status);
    }

    function onDidChange(listener) {
        if (typeof listener !== 'function') {
            return function () {};
        }
        listeners.push(listener);
        return function () {
            listeners = listeners.filter(function (item) {
                return item !== listener;
            });
        };
    }

    configure();

    return {
        getStatus,
        onDidChange,
        checkForUpdates,
        downloadUpdate,
        quitAndInstall
    };
}

module.exports = {
    createAutoUpdateController
};
