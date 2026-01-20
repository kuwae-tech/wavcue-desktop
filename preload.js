const { contextBridge, ipcRenderer } = require('electron');

const shouldApplyWindowsDragFix = () =>
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows NT');

const injectWindowsDragStyles = () => {
  if (!shouldApplyWindowsDragFix()) {
    return;
  }

  const style = document.createElement('style');
  style.setAttribute('data-wavcue', 'windows-drag-fix');
  style.textContent = `
    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
    }

    .headerDragLayer {
      background: transparent !important;
      -webkit-app-region: drag !important;
      backdrop-filter: none !important;
      filter: none !important;
      text-shadow: none !important;
      box-shadow: none !important;
      transition: none !important;
      animation: none !important;
      transform: translateZ(0) !important;
      will-change: transform !important;
    }

    .appHeader {
      padding-right: 160px !important;
      height: 44px !important;
    }

    .appHeaderUi,
    .appHeaderUi *,
    .appHeader button,
    .appHeader input,
    .appHeader select,
    .appHeader textarea,
    .appHeader a {
      -webkit-app-region: no-drag !important;
    }

    .appHeader,
    .appHeader * {
      transition: none !important;
      animation: none !important;
    }

    .appHeader .brandLogo {
      height: 41px !important;
      width: auto !important;
      max-height: 42px !important;
      display: block !important;
      margin: 1px 0 !important;
      padding: 0 !important;
      margin-left: 16px !important;
    }

    .appHeader .brand img,
    .appHeader .brand svg,
    .appHeader .hdrLeft > img:first-child,
    .appHeader .hdrLeft > svg:first-child {
      height: 41px !important;
      width: auto !important;
      max-height: 42px !important;
      display: block !important;
      margin: 1px 0 !important;
      padding: 0 !important;
      margin-left: 16px !important;
    }

    .appHeader .hdrLeft {
      display: flex !important;
      align-items: center !important;
      gap: 4px !important;
    }

    .appHeader .brand {
      display: flex !important;
      align-items: center !important;
      padding-right: 0 !important;
    }

    html,
    body {
      -webkit-user-select: none !important;
      user-select: none !important;
    }

    input,
    textarea,
    [contenteditable="true"] {
      -webkit-user-select: text !important;
      user-select: text !important;
    }
  `;

  document.head.appendChild(style);
};

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', injectWindowsDragStyles, { once: true });
}

contextBridge.exposeInMainWorld('wavcue', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ensureDefaultFolders: () => ipcRenderer.invoke('settings:ensure-default-folders'),
  openFolder: (kind) => ipcRenderer.invoke('settings:open-folder', kind),
  runCleanupNow: () => ipcRenderer.invoke('settings:run-cleanup-now'),
  runCompleteCleanup: () => ipcRenderer.invoke('settings:run-complete-cleanup'),
  getBackupStatus: () => ipcRenderer.invoke('settings:get-backup-status'),
  saveExportFile: (payload) => ipcRenderer.invoke('export:saveFile', payload),
  pickExportFolder: () => ipcRenderer.invoke('export:pick-folder'),
  writeFileBase64: (payload) => ipcRenderer.invoke('export:write-file-base64', payload),
  saveBackupReport: (payload) => ipcRenderer.invoke('export:save-backup-report', payload),
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
  isWindows: shouldApplyWindowsDragFix(),
});
