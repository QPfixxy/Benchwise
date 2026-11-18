'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('benchwise', {
  appInfo: call('app:info'),
  quit: call('app:quit'),
  hub: {
    status: call('hub:status'),
    test: call('hub:test'),
    retry: call('hub:retry'),
    onChange: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('hub:changed', listener);
      return () => ipcRenderer.removeListener('hub:changed', listener);
    },
  },
  shutdown: call('system:shutdown'),
  collectHardware: call('hardware:collect'),
  detectEnvironment: call('env:detect'),
  checkDrives: call('drives:check'),
  malware: {
    run: call('malware:run'),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('malware:progress', listener);
      return () => ipcRenderer.removeListener('malware:progress', listener);
    },
  },
  mdm: {
    run: call('mdm:run'),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('mdm:progress', listener);
      return () => ipcRenderer.removeListener('mdm:progress', listener);
    },
  },
  stress: {
    profiles: call('stress:profiles'),
    status: call('stress:status'),
    start: call('stress:start'),
    stop: call('stress:stop'),
    onEvent: (cb) => {
      const listener = (_e, event) => cb(event);
      ipcRenderer.on('stress:event', listener);
      return () => ipcRenderer.removeListener('stress:event', listener);
    },
  },
  ports: {
    start: call('ports:start'),
    poll: call('ports:poll'),
    stop: call('ports:stop'),
    volumes: call('ports:volumes'),
    prepare: call('ports:prepare'),
  },
  getSettings: call('settings:get'),
  updateSettings: call('settings:update'),
  chooseDirectory: call('dialog:chooseDir'),
  ensureMediaAccess: call('media:ensureAccess'),
  saveAudit: call('audit:save'),
  listReports: call('reports:list'),
  openReport: call('reports:open'),
  revealReport: call('reports:reveal'),
  openReportsDir: call('reports:openDir'),

  // Keyboard test: while capture is on, the main process intercepts every key
  // before menus/shortcuts (so Cmd+W, Alt, Tab etc. can be tested safely) and
  // forwards it here.
  captureKeyboard: (on) => ipcRenderer.invoke('keyboard:capture', Boolean(on)),
  onKey: (cb) => {
    const listener = (_e, key) => cb(key);
    ipcRenderer.on('keyboard:key', listener);
    return () => ipcRenderer.removeListener('keyboard:key', listener);
  },
});
