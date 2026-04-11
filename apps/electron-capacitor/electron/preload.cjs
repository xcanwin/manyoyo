'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ManyoyoNativeBridge', {
    async openExternal(url) {
        return ipcRenderer.invoke('manyoyo:openExternal', url);
    }
});
