const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wavcue', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ensureDefaultFolders: () => ipcRenderer.invoke('settings:ensure-default-folders'),
  openFolder: (kind) => ipcRenderer.invoke('settings:open-folder', kind),
  runCleanupNow: () => ipcRenderer.invoke('settings:run-cleanup-now'),
  saveExportFile: (payload) => ipcRenderer.invoke('export:saveFile', payload),
  winMinimize: () => ipcRenderer.send('window:minimize'),
  winToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  winClose: () => ipcRenderer.send('window:close'),
  winIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onCleanupProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('settings:cleanup-progress', listener);
    return () => ipcRenderer.removeListener('settings:cleanup-progress', listener);
  },
});

contextBridge.exposeInMainWorld('platform', {
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
});
