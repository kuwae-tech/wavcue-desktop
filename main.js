const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const Store = require('electron-store');

const store = new Store({
  name: 'settings',
  defaults: {
    settings: {
      autoCleanup: false,
      autoCleanupOnExport: false,
      autoCleanupOnQuit: false,
      autoCleanupOnStartup: false,
      autoReport: false,
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

const isMac = process.platform === 'darwin';

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    backgroundColor: '#0b0c0f',
    ...(isMac
      ? {
          frame: true,
          titleBarStyle: 'hiddenInset',
        }
      : {
          frame: false,
          titleBarOverlay: {
            color: '#0b0f16',
            symbolColor: '#ffffff',
            height: 36,
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

  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
    Menu.setApplicationMenu(null);
  }

  mainWindow.webContents.openDevTools({ mode: 'detach' });
};

const DAY_MS = 24 * 60 * 60 * 1000;

const formatIsoTimestamp = (date) => date.toISOString();

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
  const entries = await fs.readdir(paths.reports, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const jobId = entry.name;
    const reportsPath = path.join(paths.reports, jobId);
    const backupsPath = path.join(paths.backups, jobId);
    const jobJsonPath = path.join(reportsPath, 'Job.json');
    const jobJsonResult = await safeReadJson(jobJsonPath);
    const reportStat = await safeStat(reportsPath);
    if (!reportStat) {
      continue;
    }
    let createdAt = reportStat.mtime;
    let orphanReason = null;
    if (jobJsonResult.ok) {
      const parsed = new Date(jobJsonResult.value.createdAt);
      if (isValidDate(parsed)) {
        createdAt = parsed;
      } else {
        orphanReason = 'invalid createdAt';
      }
    } else {
      orphanReason = jobJsonResult.error;
    }
    const reportSize = await getFolderSize(reportsPath);
    const backupSize = await getFolderSize(backupsPath);
    jobs.push({
      jobId,
      reportsPath,
      backupsPath,
      createdAt,
      reportSize,
      backupSize,
      orphanReason,
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

const deleteJob = async (job, options) => {
  const { deleteMethod, trashRoot } = options;
  const errors = [];
  const totalBytes = job.reportSize + job.backupSize;
  const pathsToDelete = [
    { label: 'reports', path: job.reportsPath },
    { label: 'backups', path: job.backupsPath },
  ];

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

  const targetTrashBase = await ensureUniquePath(path.join(trashRoot, job.jobId));
  await fs.mkdir(targetTrashBase, { recursive: true });

  for (const item of pathsToDelete) {
    const stat = await safeStat(item.path);
    if (!stat) {
      continue;
    }

    if (deleteMethod === 'trash') {
      try {
        await shell.trashItem(item.path);
        continue;
      } catch (error) {
        errors.push(`${item.label}: trash failed (${error.message}), falling back to appTrash`);
      }
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

const buildCleanupLog = (payload) => {
  const lines = [];
  lines.push(`[${formatIsoTimestamp(payload.startedAt)}] Cleanup run started`);
  lines.push(
    `Settings: retentionDays=${payload.retentionDays}, backupQuotaGB=${payload.backupQuotaGB}, minKeepCount=${payload.minKeepCount}, deleteMethod=${payload.deleteMethod}`,
  );
  lines.push(`Jobs scanned: ${payload.jobCount}`);
  lines.push(`Protected jobs: ${payload.protectedCount}`);
  if (payload.orphanJobs.length > 0) {
    for (const orphan of payload.orphanJobs) {
      lines.push(`Orphan candidate: ${orphan.jobId} (${orphan.orphanReason || 'missing Job.json'})`);
    }
  }
  if (payload.deletions.length === 0) {
    lines.push('No jobs scheduled for deletion.');
  }
  for (const deletion of payload.deletions) {
    const base = `Delete ${deletion.jobId} reason=${deletion.reason} backupSize=${deletion.backupSize} reportSize=${deletion.reportSize}`;
    if (deletion.errors.length > 0) {
      lines.push(`${base} failed=${deletion.errors.join('; ')}`);
    } else {
      lines.push(`${base} ok`);
    }
  }
  lines.push(
    `Summary: deletedJobs=${payload.deletedCount}, deletedBytes=${payload.deletedBytes}, errors=${payload.errorCount}`,
  );
  lines.push(`Cleanup run finished at ${formatIsoTimestamp(payload.finishedAt)}`);
  return `${lines.join('\n')}\n`;
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
ipcMain.handle('settings:run-cleanup-now', async (event) => {
  const startedAt = new Date();
  const progress = (message) => {
    event.sender.send('settings:cleanup-progress', { message });
  };

  progress('Scanning...');

  const settings = await ensureDefaultFolders();
  const { retentionDays, backupQuotaGB, minKeepCount, deleteMethod } = settings;
  const { backups, reports, root } = settings.paths;

  const jobs = await listJobs({ backups, reports });
  const protectedJobs = new Set(jobs.slice(-minKeepCount).map((job) => job.jobId));
  const orphanJobs = jobs.filter((job) => job.orphanReason);
  const retentionThreshold = retentionDays * DAY_MS;
  const quotaBytes = backupQuotaGB * 1024 * 1024 * 1024;
  const totalBackupBytes = jobs.reduce((sum, job) => sum + job.backupSize, 0);

  const deletions = [];
  const deletionLookup = new Set();
  for (const job of jobs) {
    if (protectedJobs.has(job.jobId)) {
      continue;
    }
    if (job.orphanReason) {
      deletions.push({ ...job, reason: 'orphan (missing Job.json)' });
      deletionLookup.add(job.jobId);
      continue;
    }
    const age = Date.now() - job.createdAt.getTime();
    if (age > retentionThreshold) {
      deletions.push({ ...job, reason: `retentionDays ${retentionDays}d exceeded` });
      deletionLookup.add(job.jobId);
    }
  }

  let projectedBytes = totalBackupBytes - deletions.reduce((sum, job) => sum + job.backupSize, 0);
  if (projectedBytes > quotaBytes) {
    for (const job of jobs) {
      if (protectedJobs.has(job.jobId) || deletionLookup.has(job.jobId)) {
        continue;
      }
      deletions.push({ ...job, reason: `backupQuota ${backupQuotaGB}GB exceeded` });
      deletionLookup.add(job.jobId);
      projectedBytes -= job.backupSize;
      if (projectedBytes <= quotaBytes) {
        break;
      }
    }
  }

  if (deletions.length === 0) {
    progress('No cleanup needed.');
  }

  const trashRoot = path.join(root, 'Trash');
  await fs.mkdir(trashRoot, { recursive: true });

  let deletedBytes = 0;
  let errorCount = 0;
  const deletionResults = [];
  for (let index = 0; index < deletions.length; index += 1) {
    const job = deletions[index];
    progress(`Deleting ${index + 1}/${deletions.length} ...`);
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

  const logPayload = {
    startedAt,
    finishedAt,
    retentionDays,
    backupQuotaGB,
    minKeepCount,
    deleteMethod,
    jobCount: jobs.length,
    protectedCount: protectedJobs.size,
    orphanJobs,
    deletions: deletionResults,
    deletedCount: cleanupLastResult.deletedCount,
    deletedBytes,
    errorCount,
  };
  const logPath = path.join(reports, 'CleanupLog.txt');
  await fs.appendFile(logPath, buildCleanupLog(logPayload), 'utf8');

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
