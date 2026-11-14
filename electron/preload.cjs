const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  saveSgf: (content, defaultName) => ipcRenderer.invoke('sgf:save', { content, defaultName }),
  openSgf: () => ipcRenderer.invoke('sgf:open'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  katagoAnalyze: (payload) => ipcRenderer.invoke('katago:analyze', payload),
  katagoCancel: () => ipcRenderer.invoke('katago:cancel'),
  katagoStatus: () => ipcRenderer.invoke('katago:status'),
  readKataGoWeights: () => ipcRenderer.invoke('katago:readWebWeights'),
});
