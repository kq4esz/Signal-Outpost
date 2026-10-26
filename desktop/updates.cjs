const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, powerMonitor } = require('electron');

const CHECK_INTERVAL = 60 * 60 * 1000;
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const STARTUP_CHECK_LIMIT = 12_000;
const STARTUP_DOWNLOAD_LIMIT = 120_000;

function createUpdates({ getWindow, dataDir, beforeInstall, onStatus = () => {} }) {
  let updater, ready = false, busy, timer, disposed = false, started = false, installing = false, failures = 0;
  let startupWindow, startupActive = false, startupResolve, startupDeadline;
  const supportsAutomaticUpdates = process.platform === 'win32';
  let status = { phase: app.isPackaged ? supportsAutomaticUpdates ? 'idle' : 'manual' : 'development', version: app.getVersion(), nextCheckAt: null };
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'updates.log');
  const writeLog = (level, ...values) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${values.map(value => value instanceof Error ? value.message : String(value)).join(' ')}\n`); } catch {}
  };
  const snapshot = () => ({ ...status, startup: startupActive, canInstall: ready && !installing });
  const change = next => {
    if (disposed) return;
    status = { ...status, ...next };
    try { fs.writeFileSync(path.join(dataDir, 'updates.json'), JSON.stringify(snapshot(), null, 2)); } catch {}
    for (const target of [startupWindow, getWindow()]) {
      if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send('sdr:update-status', snapshot());
    }
    onStatus(snapshot());
  };
  const message = options => {
    const parent = startupWindow || getWindow();
    return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  };
  function finishStartup(openReceiver) {
    if (!startupActive) return;
    startupActive = false;
    clearTimeout(startupDeadline);
    const resolve = startupResolve;
    startupResolve = null;
    change({});
    if (openReceiver && startupWindow && !startupWindow.isDestroyed()) startupWindow.destroy();
    resolve?.(openReceiver);
  }
  function stopTimers() { clearTimeout(timer); clearTimeout(startupDeadline); }
  function schedule() {
    clearTimeout(timer);
    if (disposed || ready || installing) return;
    const delay = status.phase === 'error' ? RETRY_DELAYS[Math.min(Math.max(failures - 1, 0), RETRY_DELAYS.length - 1)] : CHECK_INTERVAL;
    change({ nextCheckAt: new Date(Date.now() + delay).toISOString() });
    timer = setTimeout(() => { void check(); }, delay);
    timer.unref();
  }
  function failed(error) {
    if (!(error instanceof Error)) error = new Error(String(error));
    installing = false;
    writeLog('error', error);
    change({ phase: 'error', error: error.message, checkedAt: new Date().toISOString(), nextCheckAt: null });
    finishStartup(true);
  }
  async function install() {
    if (!supportsAutomaticUpdates) return false;
    if (!ready || disposed || installing) return false;
    installing = true;
    stopTimers();
    change({ phase: 'installing', nextCheckAt: null, error: null });
    try {
      await beforeInstall();
      if (disposed) return false;
      writeLog('info', `Installing ${status.availableVersion} and reopening Signal Outpost`);
      // Silent NSIS installation with --force-run reopens the updated application.
      updater.quitAndInstall(true, true);
      if (status.phase === 'error') { installing = false; return false; }
      return true;
    } catch (error) {
      installing = false;
      failed(error);
      return false;
    }
  }
  async function check(manual = false) {
    if (!supportsAutomaticUpdates) {
      if (manual) await message({ type: 'info', title: 'Signal Outpost updates', message: process.platform === 'darwin' ? 'Install macOS updates from GitHub Releases.' : 'Install Linux updates from GitHub Releases.', detail: 'Choose the package for your desktop from https://github.com/kq4esz/Signal-Outpost/releases/latest.' });
      return;
    }
    if (!app.isPackaged) {
      if (manual) await message({ type: 'info', title: 'Signal Outpost updates', message: 'Automatic updates run in the installed Windows application.', detail: `Install the ${process.platform === 'darwin' ? 'macOS' : 'Windows'} package from GitHub Releases.` });
      return;
    }
    if (disposed || installing) return;
    if (!updater) {
      if (manual) await message({ type: 'warning', title: 'Update check failed', message: 'The updater could not start.', detail: `${status.error || 'Reinstall the latest Windows setup executable from GitHub Releases.'}\n\nhttps://github.com/kq4esz/Signal-Outpost/releases/latest` });
      return;
    }
    if (ready) {
      if (manual) {
        const result = await message({ type: 'info', title: 'Update ready', message: `Signal Outpost ${status.availableVersion} is ready to install.`, detail: 'The receiver will stop before restarting. Memories and settings are preserved. You can also close the app normally to install the update.', buttons: ['Restart and install', 'Later'], defaultId: 1, cancelId: 1 });
        if (result.response === 0) await install();
      }
      return;
    }
    if (busy) {
      if (manual) await message({ type: 'info', title: 'Signal Outpost updates', message: status.phase === 'downloading' ? `Downloading Signal Outpost ${status.availableVersion}` : 'An update check is already running.', detail: status.phase === 'downloading' ? `${Math.floor(status.percent || 0)}% complete. You can keep listening while the update downloads.` : 'Update progress is displayed in the application.' });
      return busy;
    }
    clearTimeout(timer);
    busy = (async () => {
      try {
        const result = await updater.checkForUpdates();
        if (!result) throw new Error('The installed application updater did not return an update result.');
        // Attach rejection handling immediately: metadata checks finish before downloads.
        const downloaded = result.downloadPromise?.then(() => null, error => error);
        if (manual && status.phase === 'current') await message({ type: 'info', title: 'Signal Outpost updates', message: `Signal Outpost ${app.getVersion()} is up to date.` });
        else if (manual && status.phase === 'downloading') await message({ type: 'info', title: 'Update available', message: `Downloading Signal Outpost ${status.availableVersion}`, detail: 'The application will show a Restart and install button when the download is ready. It also installs after normal app exit.' });
        const error = await downloaded;
        if (error) throw error;
        failures = 0;
      } catch (error) {
        failures++;
        failed(error);
        if (manual && !disposed) await message({ type: 'warning', title: 'Update check failed', message: 'Could not download or check for updates.', detail: `${error.message}\n\nThe app will retry automatically. If this keeps happening, download the latest installer from https://github.com/kq4esz/Signal-Outpost/releases/latest and run it over the existing installation.` });
      } finally { busy = null; schedule(); }
    })();
    return busy;
  }
  function validSender(event) {
    return event.senderFrame === event.sender.mainFrame && [getWindow(), startupWindow].some(target => target && !target.isDestroyed() && event.sender === target.webContents);
  }
  ipcMain.handle('sdr:update-status', event => {
    if (!validSender(event)) throw new Error('Unavailable outside Signal Outpost.');
    return snapshot();
  });
  ipcMain.handle('sdr:update-check', async event => {
    if (!validSender(event)) throw new Error('Unavailable outside Signal Outpost.');
    await check();
    return snapshot();
  });
  ipcMain.handle('sdr:update-install', async event => {
    if (!validSender(event)) throw new Error('Unavailable outside Signal Outpost.');
    return install();
  });
  ipcMain.on('sdr:update-continue', event => {
    if (!validSender(event) || event.sender !== startupWindow?.webContents || installing) return;
    writeLog('info', 'Startup update deferred; continuing the check or download in the background');
    finishStartup(true);
  });
  const resume = () => { if (status.phase === 'error' || !status.checkedAt || Date.now() - Date.parse(status.checkedAt) > CHECK_INTERVAL) void check(); };
  async function start() {
    if (started || disposed) return !installing;
    started = true;
    if (!supportsAutomaticUpdates || !app.isPackaged) return true;
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.logger = { ...Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...values) => writeLog(level, ...values)])), debug: () => {} };
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.autoRunAppAfterInstall = true;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.disableWebInstaller = true;
      updater.on('checking-for-update', () => change({ phase: 'checking', error: null, nextCheckAt: null, percent: 0 }));
      updater.on('update-not-available', () => {
        change({ phase: 'current', availableVersion: null, error: null, checkedAt: new Date().toISOString() });
        finishStartup(true);
      });
      updater.on('update-available', info => {
        change({ phase: 'downloading', availableVersion: info.version, percent: 0, error: null, checkedAt: new Date().toISOString() });
        if (startupActive) {
          clearTimeout(startupDeadline);
          startupDeadline = setTimeout(() => { writeLog('info', 'Startup download taking longer than two minutes; continuing in the background'); finishStartup(true); }, STARTUP_DOWNLOAD_LIMIT);
        }
      });
      updater.on('download-progress', progress => change({ phase: 'downloading', percent: Math.round(progress.percent), bytesPerSecond: progress.bytesPerSecond }));
      updater.on('error', failed);
      updater.on('update-downloaded', info => {
        ready = true;
        change({ phase: 'ready', availableVersion: info.version, percent: 100, error: null, nextCheckAt: null });
        if (startupActive) void install().then(installed => finishStartup(!installed));
      });
      powerMonitor.on('resume', resume);
      startupActive = true;
      const startup = new Promise(resolve => { startupResolve = resolve; });
      startupWindow = new BrowserWindow({ width: 560, height: 380, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false, show: false,
        title: 'Signal Outpost updates', backgroundColor: '#0a1018', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      startupWindow.setMenu(null);
      startupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      startupWindow.webContents.on('will-navigate', event => event.preventDefault());
      startupWindow.once('ready-to-show', () => { if (!process.env.SDREXTREME_TEST_MODE && startupWindow && !startupWindow.isDestroyed()) startupWindow.show(); });
      startupWindow.on('closed', () => {
        startupWindow = null;
        if (startupActive) { finishStartup(false); app.quit(); }
      });
      void startupWindow.loadFile(path.join(__dirname, 'startup.html')).catch(error => { writeLog('warn', error); finishStartup(true); });
      startupDeadline = setTimeout(() => { writeLog('info', 'Startup check taking longer than 12 seconds; continuing in the background'); finishStartup(true); }, STARTUP_CHECK_LIMIT);
      writeLog('info', `Startup update check for Signal Outpost ${app.getVersion()}`);
      void check();
      return startup;
    } catch (error) { failed(error); return true; }
  }
  return {
    start, check, install, snapshot,
    focusStartup: () => { if (startupWindow && !startupWindow.isDestroyed()) { if (startupWindow.isMinimized()) startupWindow.restore(); startupWindow.show(); startupWindow.focus(); } },
    dispose: () => { finishStartup(false); disposed = true; stopTimers(); powerMonitor.removeListener('resume', resume); }
  };
}

module.exports = { createUpdates };
