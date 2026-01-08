const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const Store = require('electron-store');

const store = new Store({
  name: 'settings',
  defaults: {
    settings: {
      autoCleanup: false,
      retentionDays: 30,
      backupQuotaGB: 25,
      minKeepCount: 20,
      deleteMethod: 'trash',
      paths: {
        root: '',
        exports: '',
        backups: '',
        reports: '',
      },
    },
  },
});

const getSettings = () => store.get('settings');

const setSettings = (patch) => {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    paths: {
      ...current.paths,
      ...(patch.paths || {}),
    },
  };
  store.set('settings', next);
  return next;
};

const ensureFolders = async (root) => {
  const exportsPath = path.join(root, 'Exports');
  const backupsPath = path.join(root, 'Backups');
  const reportsPath = path.join(root, 'Reports');
  await fs.mkdir(exportsPath, { recursive: true });
  await fs.mkdir(backupsPath, { recursive: true });
  await fs.mkdir(reportsPath, { recursive: true });
  return {
    root,
    exports: exportsPath,
    backups: backupsPath,
    reports: reportsPath,
  };
};

const ensureDefaultFolders = async () => {
  const current = getSettings();
  const existingPaths = current.paths || {};
  if (existingPaths.root) {
    try {
      const paths = await ensureFolders(existingPaths.root);
      return setSettings({ paths });
    } catch (error) {
      console.warn('Stored paths invalid, reinitializing.', error);
    }
  }

  const documentsRoot = path.join(app.getPath('documents'), 'WavCue');
  try {
    const paths = await ensureFolders(documentsRoot);
    return setSettings({ paths });
  } catch (error) {
    console.warn('Failed to create default Documents folders.', error);
  }

  try {
    const result = await dialog.showOpenDialog({
      title: 'Select a folder for WavCue data',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedRoot = path.join(result.filePaths[0], 'WavCue');
      const paths = await ensureFolders(selectedRoot);
      return setSettings({ paths });
    }
  } catch (error) {
    console.warn('Failed to create folders in user-selected location.', error);
  }

  const fallbackRoot = path.join(app.getPath('userData'), 'WavCue');
  const fallbackPaths = await ensureFolders(fallbackRoot);
  return setSettings({ paths: fallbackPaths });
};

let settingsWindow = null;

const createSettingsWindow = () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 520,
    title: 'WavCue Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
};

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'prototype.html'));
  mainWindow.webContents.openDevTools({ mode: 'detach' });
};

const buildMenu = () => {
  const template = [
    {
      label: app.name,
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => createSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

app.whenReady().then(async () => {
  buildMenu();
  await ensureDefaultFolders();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_event, patch) => setSettings(patch || {}));
ipcMain.handle('settings:ensure-default-folders', () => ensureDefaultFolders());
ipcMain.handle('settings:open-folder', async (_event, kind) => {
  const settings = getSettings();
  const paths = settings.paths || {};
  const target = paths[kind];
  if (!target) {
    await ensureDefaultFolders();
  }
  const resolved = (getSettings().paths || {})[kind];
  if (!resolved) {
    return { ok: false, message: 'Folder path unavailable.' };
  }
  const result = await shell.openPath(resolved);
  return result ? { ok: false, message: result } : { ok: true };
});
ipcMain.handle('settings:run-cleanup-now', () => {
  console.log('Cleanup invoked from settings UI.');
  return { ok: true };
});
