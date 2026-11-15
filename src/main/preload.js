'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('qudit', {
  appInfo: call('app:info'),
  collectHardware: call('hardware:collect'),
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
