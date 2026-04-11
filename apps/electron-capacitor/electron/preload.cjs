'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ManyoyoNativeBridge', {
    async openWorkbench(url) {
        return ipcRenderer.invoke('manyoyo:openWorkbench', url);
    },
    async saveWorkbenchUrl(url) {
        return ipcRenderer.invoke('manyoyo:saveWorkbenchUrl', url);
    },
    async openExternal(url) {
        return ipcRenderer.invoke('manyoyo:openExternal', url);
    }
});
