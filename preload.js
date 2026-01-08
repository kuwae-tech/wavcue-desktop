const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wavcue', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ensureDefaultFolders: () => ipcRenderer.invoke('settings:ensure-default-folders'),
  openFolder: (kind) => ipcRenderer.invoke('settings:open-folder', kind),
  runCleanupNow: () => ipcRenderer.invoke('settings:run-cleanup-now'),
  saveExportFile: (payload) => ipcRenderer.invoke('export:saveFile', payload),
  onCleanupProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('settings:cleanup-progress', listener);
    return () => ipcRenderer.removeListener('settings:cleanup-progress', listener);
  },
});
