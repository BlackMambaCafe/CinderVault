'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState', 'add', 'start', 'pause', 'cancel', 'retry', 'remove', 'clearFinished', 'updateSettings', 'chooseOutput', 'openOutput', 'showFile', 'openBackgrounds', 'refreshBackgrounds', 'checkUpdates', 'installUpdate', 'scanChannel', 'cancelChannelScan', 'getChannelEntries', 'downloadChannel'];
const bridge = Object.fromEntries(methods.map(method => [method, (...args) => ipcRenderer.invoke(`downloader:${method}`, ...args)]));
bridge.onState = callback => {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('downloader:state', listener);
  return () => ipcRenderer.removeListener('downloader:state', listener);
};
contextBridge.exposeInMainWorld('downloader', Object.freeze(bridge));
