'use strict';

const { ipcMain, BrowserWindow, powerSaveBlocker } = require('electron');

/**
 * The main-process half of the bridge that index.html talks to through
 * preload.js. Kept separate from main.js so the smoke test can register the
 * real handlers against its own window instead of reimplementing them.
 */

let powerSaveBlockerId = null;
let registered = false;

/** Window options shared by the app and the test, so they behave identically. */
const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // Chromium throttles timers in hidden or minimised windows. The timer
  // recomputes from the wall clock so the display would still be correct, but
  // the alarm needs to ring on time even when the window is not in front.
  backgroundThrottling: false,
  // Without this the alarm is silent on an automatic start, because no user
  // gesture has happened.
  autoplayPolicy: 'no-user-gesture-required'
};

function startKeepAwake() {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) return;
  // 'prevent-display-sleep' also prevents system sleep, which is what a
  // projector or foyer display needs for a three-hour session.
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
}

function stopKeepAwake() {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = null;
}

function isKeepAwakeActive() {
  return powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId);
}

/** Registers the IPC handlers once per process. */
function registerBridge() {
  if (registered) return;
  registered = true;

  ipcMain.handle('timer:set-fullscreen', (event, wanted) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setFullScreen(!!wanted);
  });

  ipcMain.handle('timer:set-keep-awake', (event, wanted) => {
    if (wanted) startKeepAwake(); else stopKeepAwake();
  });
}

/**
 * Push the window's fullscreen state to the page whenever it changes.
 *
 * The page needs this answer synchronously inside a keydown handler, to decide
 * whether Escape should leave fullscreen or reopen the settings panel. Pushing
 * the state and caching it in the preload avoids a synchronous IPC round trip,
 * which would deadlock the renderer if the main process were ever busy or the
 * handler missing.
 */
function attachWindow(win) {
  const notify = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('timer:fullscreen-changed', win.isFullScreen());
  };

  win.on('enter-full-screen', notify);
  win.on('leave-full-screen', notify);
  // Re-sync after a load or reload, which clears the preload's cached value.
  win.webContents.on('did-finish-load', notify);
}

module.exports = {
  WEB_PREFERENCES,
  registerBridge,
  attachWindow,
  startKeepAwake,
  stopKeepAwake,
  isKeepAwakeActive
};
