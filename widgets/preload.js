'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function onState(callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('widget-state', listener);
  return () => ipcRenderer.removeListener('widget-state', listener);
}

contextBridge.exposeInMainWorld('widget', Object.freeze({
  get: () => ipcRenderer.invoke('widget-get'),
  action: (action) => ipcRenderer.invoke('widget-action', action),
  editing: (enabled) => ipcRenderer.invoke('widget-editing', enabled),
  editor: (enabled) => ipcRenderer.invoke('widget-editor', enabled),
  content: (content) => ipcRenderer.invoke('widget-content', content),
  adjustGoal: (delta) => ipcRenderer.invoke('widget-goal-step', delta),
  pickImage: () => ipcRenderer.invoke('widget-pick-image'),
  pickApp: () => ipcRenderer.invoke('widget-pick-app'),
  geometry: (bounds) => ipcRenderer.invoke('widget-geometry', bounds),
  measure: (height) => ipcRenderer.send('widget-measure', height),
  openLink: (index) => ipcRenderer.invoke('widget-open-link', index),
  onState,
}));
