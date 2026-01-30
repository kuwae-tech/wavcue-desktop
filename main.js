const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const Store = require('electron-store');

const SETTINGS_SCHEMA_VERSION = 2;
const RECOMMENDED_SETTINGS = {
  autoCleanup: true,
  retentionDays: 30,
  backupQuotaGB: 5,
  minKeepCount: 20,
  deleteMethod: 'trash',
};

const store = new Store({
  name: 'settings',
  defaults: {
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      autoCleanup: true,
      autoCleanupOnExport: false,
      autoCleanupOnQuit: false,
      autoCleanupOnStartup: false,
      autoBackupEnabled: true,
      licenseKey: '',
      licenseTier: 'demo',
      retentionDays: 30,
      backupQuotaGB: 5,
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

const migrateSettingsSchema = () => {
  const current = getSettings();
  const currentVersion = current?.schemaVersion;
  if (currentVersion !== undefined && currentVersion >= SETTINGS_SCHEMA_VERSION) {
    return;
  }
  const patch = {
    ...RECOMMENDED_SETTINGS,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  setSettings(patch);
};

const ensureFolders = async (root) => {
  const exportsPath = path.join(root, 'Exports');
  const backupsPath = path.join(root, 'Backups');
  await fs.mkdir(exportsPath, { recursive: true });
  await fs.mkdir(backupsPath, { recursive: true });
  return {
    root,
    exports: exportsPath,
    backups: backupsPath,
    reports: path.join(root, 'Reports'),
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

const isMac = process.platform === 'darwin';

const createWindow = () => {
  const initialWidth = 1400;
  const initialHeight = 900;
  const mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 1240,
    minHeight: 680,
    autoHideMenuBar: true,
    backgroundColor: '#0b0c0f',
    ...(isMac
      ? {
          frame: true,
          titleBarStyle: 'hiddenInset',
        }
      : {
          frame: true,
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#ffffff',
            height: 44,
          },
        }),
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'prototype.html'));
  mainWindow.setMinimumSize(1240, 700);

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
    Menu.setApplicationMenu(null);
  }

  mainWindow.webContents.openDevTools({ mode: 'detach' });
};

const DAY_MS = 24 * 60 * 60 * 1000;

const isValidDate = (value) => Number.isFinite(value?.getTime?.());

const getFolderSize = async (targetPath) => {
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) {
          return getFolderSize(entryPath);
        }
        if (entry.isFile()) {
          const stats = await fs.stat(entryPath);
          return stats.size;
        }
        return 0;
      }),
    );
    return sizes.reduce((sum, value) => sum + value, 0);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
};

const safeStat = async (targetPath) => {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const safeReadJson = async (targetPath) => {
  try {
    const raw = await fs.readFile(targetPath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, error: 'missing' };
    }
    return { ok: false, error: error.message };
  }
};

const listJobs = async (paths) => {
  const entries = await fs.readdir(paths.backups, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const jobId = entry.name;
    const jobPath = path.join(paths.backups, jobId);
    const metaPath = path.join(jobPath, 'meta.json');
    const metaResult = await safeReadJson(metaPath);
    const jobStat = await safeStat(jobPath);
    if (!jobStat) {
      continue;
    }
    let createdAt = jobStat.mtime;
    if (metaResult.ok) {
      const parsed = new Date(metaResult.value.createdAt);
      if (isValidDate(parsed)) {
        createdAt = parsed;
      }
    }
    const totalBytes = await getFolderSize(jobPath);
    jobs.push({
      jobId,
      jobPath,
      createdAt,
      totalBytes,
    });
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
};

const ensureUniquePath = async (basePath) => {
  const stat = await safeStat(basePath);
  if (!stat) {
    return basePath;
  }
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  return `${basePath}-${suffix}`;
};

const sanitizeFileSegment = (value) =>
  String(value || 'output')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'output';

const formatJobStamp = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const shortenSegment = (value, maxLength = 60) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'output';
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength).trim();
};

const ensureUniqueJobFolderName = async (baseJobId, backupsPath) => {
  let jobId = baseJobId;
  let index = 1;
  while (await safeStat(path.join(backupsPath, jobId))) {
    const suffix = String(index).padStart(2, '0');
    jobId = `${baseJobId}_${suffix}`;
    index += 1;
  }
  return jobId;
};

const movePath = async (source, destination) => {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === 'EXDEV') {
      await fs.cp(source, destination, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
      return;
    }
    throw error;
  }
};

async function moveToOsTrash(targetPath) {
  // Electron shell.trashItem moves a file/folder to the OS trash (Recycle Bin / Trash)
  // https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath
  try {
    if (!targetPath) {
      throw new Error('Empty path');
    }
    await shell.trashItem(targetPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

const deleteJob = async (job, options) => {
  const { deleteMethod, trashRoot } = options;
  const errors = [];
  const totalBytes = job.totalBytes;
  const pathsToDelete = [{ label: 'backups', path: job.jobPath }];

  if (deleteMethod === 'hard') {
    for (const item of pathsToDelete) {
      const stat = await safeStat(item.path);
      if (!stat) {
        continue;
      }
      try {
        await fs.rm(item.path, { recursive: true, force: true });
      } catch (error) {
        errors.push(`${item.label}: ${error.message}`);
      }
    }
    return { deletedBytes: totalBytes, errors };
  }

  let targetTrashBase = null;
  if (deleteMethod !== 'trash') {
    targetTrashBase = await ensureUniquePath(path.join(trashRoot, job.jobId));
    await fs.mkdir(targetTrashBase, { recursive: true });
  }

  for (const item of pathsToDelete) {
    const stat = await safeStat(item.path);
    if (!stat) {
      continue;
    }

    if (deleteMethod === 'trash') {
      const result = await moveToOsTrash(item.path);
      if (!result.ok) {
        errors.push(`${item.label}: trash failed (${result.error})`);
      }
      continue;
    }

    const destination = path.join(targetTrashBase, item.label);
    try {
      await movePath(item.path, destination);
    } catch (error) {
      errors.push(`${item.label}: appTrash failed (${error.message})`);
    }
  }

  return { deletedBytes: totalBytes, errors };
};

const ensureWavExtension = (targetPath) => {
  if (!targetPath) {
    return targetPath;
  }
  const ext = path.extname(targetPath);
  if (!ext) {
    return `${targetPath}.wav`;
  }
  if (ext.toLowerCase() === '.wav') {
    return targetPath;
  }
  return `${targetPath.slice(0, -ext.length)}.wav`;
};

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  migrateSettingsSchema();
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

ipcMain.on('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.minimize();
  }
});
ipcMain.on('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return;
  }
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});
ipcMain.on('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
  }
});
ipcMain.handle('window:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isMaximized() : false;
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_event, patch) => setSettings(patch || {}));
ipcMain.handle('license:get-state', () => {
  const settings = getSettings() || {};
  const tier = settings.licenseTier || 'demo';
  return { tier };
});
ipcMain.handle('license:set-key', (_event, rawKey) => {
  try {
    const key = String(rawKey || '').trim();
    let tier = 'demo';
    let ok = true;
    let reason;
    if (!key) {
      ok = false;
      reason = 'empty';
    } else if (key === 'WAVCUE_PRO_TEST') {
      tier = 'pro';
    } else if (key === 'WAVCUE_STD_TEST') {
      tier = 'standard';
    } else if (key === 'WAVCUE_DEMO') {
      tier = 'demo';
    } else {
      ok = false;
      reason = 'invalid';
    }
    setSettings({ licenseKey: key, licenseTier: tier });
    return { ok, tier, reason };
  } catch (error) {
    return { ok: false, tier: 'demo', reason: 'exception' };
  }
});
ipcMain.handle('license:clear', () => {
  try {
    setSettings({ licenseKey: '', licenseTier: 'demo' });
    return { ok: true, tier: 'demo' };
  } catch (error) {
    return { ok: false, tier: 'demo', reason: 'exception' };
  }
});
ipcMain.handle('settings:ensure-default-folders', () => ensureDefaultFolders());
ipcMain.handle('settings:open-folder', async (_event, kind) => {
  if (kind === 'reports') {
    return { ok: false, message: 'Reports folder is deprecated.' };
  }
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
ipcMain.handle('settings:run-cleanup-now', async (event) => {
  const startedAt = new Date();
  const progress = (message) => {
    event.sender.send('settings:cleanup-progress', { message });
  };

  progress('スキャン中...');

  const settings = await ensureDefaultFolders();
  const { retentionDays, backupQuotaGB, minKeepCount, deleteMethod } = settings;
  const { backups, root } = settings.paths;

  const jobs = await listJobs({ backups });
  const protectedJobs = new Set(jobs.slice(-minKeepCount).map((job) => job.jobId));
  const retentionThreshold = retentionDays * DAY_MS;
  const quotaBytes = backupQuotaGB * 1024 * 1024 * 1024;
  const totalBackupBytes = jobs.reduce((sum, job) => sum + job.totalBytes, 0);

  const deletions = [];
  const deletionLookup = new Set();
  for (const job of jobs) {
    if (protectedJobs.has(job.jobId)) {
      continue;
    }
    const age = Date.now() - job.createdAt.getTime();
    if (age > retentionThreshold) {
      deletions.push({ ...job, reason: `retentionDays ${retentionDays}d exceeded` });
      deletionLookup.add(job.jobId);
    }
  }

  let projectedBytes = totalBackupBytes - deletions.reduce((sum, job) => sum + job.totalBytes, 0);
  if (projectedBytes > quotaBytes) {
    for (const job of jobs) {
      if (protectedJobs.has(job.jobId) || deletionLookup.has(job.jobId)) {
        continue;
      }
      deletions.push({ ...job, reason: `backupQuota ${backupQuotaGB}GB exceeded` });
      deletionLookup.add(job.jobId);
      projectedBytes -= job.totalBytes;
      if (projectedBytes <= quotaBytes) {
        break;
      }
    }
  }

  if (deletions.length === 0) {
    progress('削除対象はありません。');
  }

  let trashRoot = null;
  if (deleteMethod !== 'hard' && deleteMethod !== 'trash') {
    trashRoot = path.join(root, 'Trash');
    await fs.mkdir(trashRoot, { recursive: true });
  }

  let deletedBytes = 0;
  let errorCount = 0;
  const deletionResults = [];
  for (let index = 0; index < deletions.length; index += 1) {
    const job = deletions[index];
    progress(`削除中 ${index + 1}/${deletions.length}...`);
    const result = await deleteJob(job, { deleteMethod, trashRoot });
    if (result.errors.length > 0) {
      errorCount += 1;
    } else {
      deletedBytes += result.deletedBytes;
    }
    deletionResults.push({ ...job, errors: result.errors, reason: job.reason });
  }

  const finishedAt = new Date();
  const cleanupLastResult = {
    timestamp: finishedAt.toISOString(),
    deletedCount: deletions.length - errorCount,
    deletedBytes,
    errorCount,
  };
  setSettings({ cleanupLastResult });

  progress('Cleanup finished.');

  return {
    ok: errorCount === 0,
    summary: cleanupLastResult,
    deletions: deletionResults.map((job) => ({
      jobId: job.jobId,
      reason: job.reason,
      errors: job.errors,
    })),
  };
});

ipcMain.handle('settings:run-complete-cleanup', async (event) => {
  const startedAt = new Date();
  const progress = (message) => {
    event.sender.send('settings:cleanup-progress', { message });
  };

  progress('スキャン中...');

  const settings = await ensureDefaultFolders();
  const { retentionDays, backupQuotaGB, minKeepCount, deleteMethod } = settings;
  const { backups, root } = settings.paths;

  const jobs = await listJobs({ backups });
  const deletions = jobs.map((job) => ({ ...job, reason: 'manual complete cleanup' }));

  if (deletions.length === 0) {
    progress('削除対象はありません。');
  }

  let trashRoot = null;
  if (deleteMethod !== 'hard' && deleteMethod !== 'trash') {
    trashRoot = path.join(root, 'Trash');
    await fs.mkdir(trashRoot, { recursive: true });
  }

  let deletedBytes = 0;
  let errorCount = 0;
  const deletionResults = [];
  for (let index = 0; index < deletions.length; index += 1) {
    const job = deletions[index];
    progress(`削除中 ${index + 1}/${deletions.length}...`);
    const result = await deleteJob(job, { deleteMethod, trashRoot });
    if (result.errors.length > 0) {
      errorCount += 1;
    } else {
      deletedBytes += result.deletedBytes;
    }
    deletionResults.push({ ...job, errors: result.errors, reason: job.reason });
  }

  const finishedAt = new Date();
  const cleanupLastResult = {
    timestamp: finishedAt.toISOString(),
    deletedCount: deletions.length - errorCount,
    deletedBytes,
    errorCount,
  };
  setSettings({ cleanupLastResult });

  progress('Cleanup finished.');

  return {
    ok: errorCount === 0,
    summary: cleanupLastResult,
    deletions: deletionResults.map((job) => ({
      jobId: job.jobId,
      reason: job.reason,
      errors: job.errors,
    })),
  };
});

ipcMain.handle('settings:get-backup-status', async () => {
  const settings = await ensureDefaultFolders();
  const { backups } = settings.paths;
  const jobs = await listJobs({ backups });
  const totalBytes = jobs.reduce((sum, job) => sum + job.totalBytes, 0);
  const oldest = jobs[0]?.createdAt || null;
  const latest = jobs[jobs.length - 1]?.createdAt || null;
  return {
    jobCount: jobs.length,
    totalBytes,
    oldest: oldest ? oldest.toISOString() : null,
    latest: latest ? latest.toISOString() : null,
  };
});

ipcMain.handle('export:pickFolder', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '書き出し先フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) {
      return { ok: false, canceled: true };
    }
    return { ok: true, folderPath: filePaths[0] };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('export:writeFileBase64', async (_event, { folderPath, fileName, dataBase64 }) => {
  try {
    if (!folderPath || !fileName || !dataBase64) {
      return { ok: false, error: 'Missing export parameters.' };
    }
    const resolvedPath = ensureWavExtension(path.join(folderPath, fileName));
    const buf = Buffer.from(dataBase64, 'base64');
    fsSync.writeFileSync(resolvedPath, buf, { flag: 'wx' });
    return { ok: true, filePath: resolvedPath };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return { ok: false, error: 'EEXIST' };
    }
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('export:saveFile', async (_event, { defaultName, dataBase64 }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '書き出し先を選択',
      defaultPath: defaultName,
      buttonLabel: '保存',
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    const resolvedPath = ensureWavExtension(filePath);
    const buf = Buffer.from(dataBase64, 'base64');
    fsSync.writeFileSync(resolvedPath, buf);
    return { ok: true, filePath: resolvedPath };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('export:save-backup-report', async (_event, payload) => {
  try {
    const exportDataBase64 = payload?.exportDataBase64 || payload?.backupDataBase64;
    if (!exportDataBase64) {
      return { ok: false, error: 'Missing backup data.' };
    }
    const settings = await ensureDefaultFolders();
    const { backups } = settings.paths;
    const createdAt = new Date();
    const hint = typeof payload?.backupNameHint === 'string' ? payload.backupNameHint.trim() : '';
    const fallbackBaseName = payload?.sourceBaseName || payload?.sourceFileName || 'output';
    const baseNameForJob = hint || fallbackBaseName || 'export';
    const sourceBaseName = sanitizeFileSegment(baseNameForJob);
    const safeBaseName = shortenSegment(sourceBaseName || 'export');
    const stamp = formatJobStamp(createdAt);
    const baseJobId = `${stamp}__${safeBaseName}__EXPORT`;
    const jobFolderName = await ensureUniqueJobFolderName(baseJobId, backups);
    const jobPath = path.join(backups, jobFolderName);
    await fs.mkdir(jobPath, { recursive: true });

    const exportFileName = 'export.wav';
    const reportFileName = 'report.txt';
    const metaFileName = 'meta.json';
    const exportTarget = path.join(jobPath, exportFileName);
    const reportTarget = path.join(jobPath, reportFileName);
    const metaTarget = path.join(jobPath, metaFileName);

    const exportBuf = Buffer.from(exportDataBase64, 'base64');
    await fs.writeFile(exportTarget, exportBuf);
    await fs.writeFile(reportTarget, String(payload.reportText || ''), 'utf8');

    const meta = {
      createdAt: createdAt.toISOString(),
      jobFolder: jobFolderName,
      source: {
        name: payload.sourceFileName || '',
        sizeBytes: Number.isFinite(payload.sourceSizeBytes) ? payload.sourceSizeBytes : null,
        mtime: payload.sourceMtime || null,
        hash: payload.sourceHash || null,
      },
      export: {
        name: payload.exportFileName || exportFileName,
        sizeBytes: exportBuf.length,
        sampleRate: Number.isFinite(payload.exportSampleRate) ? payload.exportSampleRate : null,
        channels: Number.isFinite(payload.exportChannels) ? payload.exportChannels : null,
      },
      qc: {
        result: payload.qcResult || 'UNKNOWN',
        notes: payload.qcNotes || null,
      },
      app: {
        version: payload.appVersion || null,
      },
    };
    await fs.writeFile(metaTarget, JSON.stringify(meta, null, 2), 'utf8');

    return {
      ok: true,
      jobFolderName,
      exportFileName,
      reportFileName,
      exportPath: exportTarget,
      reportPath: reportTarget,
      metaPath: metaTarget,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
