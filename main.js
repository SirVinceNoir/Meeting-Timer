'use strict';

const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const bridge = require('./shell-bridge');

/**
 * Electron shell for the Meeting Timer.
 *
 * The timer itself is plain HTML/CSS/JS in index.html and still works when
 * opened directly in a browser. This shell adds the three things a browser
 * cannot do reliably for an unattended, all-evening display:
 *
 *   1. Audio that rings on an automatic start with no prior user gesture.
 *   2. Fullscreen that can be entered without a user gesture.
 *   3. A power-save block that survives the window being hidden, and timers
 *      that keep running when the window is minimised.
 */

// With ELECTRON_RUN_AS_NODE set, the Electron binary starts as plain Node and
// there is no `app` to hook into, so the app would exit silently with status 0
// and no window. Some editors set that variable for their integrated terminal.
if (!app) {
  console.error(
    'Meeting Timer cannot start: the Electron runtime is in Node mode.\n' +
    'ELECTRON_RUN_AS_NODE is set in this environment. Clear it and try again.'
  );
  process.exit(1);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#041e42',
    title: 'Meeting Timer',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: Object.assign({
      preload: path.join(__dirname, 'preload.js')
    }, bridge.WEB_PREFERENCES)
  });

  mainWindow.removeMenu();
  bridge.attachWindow(mainWindow);
  mainWindow.loadFile('index.html');

  // Avoid the white flash before the first paint.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
    bridge.stopKeepAwake();
  });

  // Keep navigation inside the app; send any real link to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
}

// A second launch should focus the existing window rather than open a second
// timer, which would ring twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    bridge.registerBridge();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  bridge.stopKeepAwake();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => bridge.stopKeepAwake());
