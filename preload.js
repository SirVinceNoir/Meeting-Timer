'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the page gets onto the Electron side. index.html checks for
 * `window.timerHost` and falls back to the browser Fullscreen and Wake Lock
 * APIs when it is absent, so the same file still works opened directly in a
 * browser.
 */

// Mirrors the window's fullscreen state, pushed from the main process. Cached
// rather than fetched synchronously: the page needs the answer inside a
// keydown handler, and a synchronous IPC call would hang the renderer if the
// main process were busy.
let fullscreen = false;

ipcRenderer.on('timer:fullscreen-changed', (_event, value) => {
  fullscreen = !!value;
});

contextBridge.exposeInMainWorld('timerHost', {
  setFullscreen(wanted) {
    // Optimistic, so an Escape pressed twice in quick succession does not act
    // on a stale value before the main process has echoed the change back.
    fullscreen = !!wanted;
    ipcRenderer.invoke('timer:set-fullscreen', !!wanted);
  },

  isFullscreen() {
    return fullscreen;
  },

  setKeepAwake(wanted) {
    ipcRenderer.invoke('timer:set-keep-awake', !!wanted);
  }
});
