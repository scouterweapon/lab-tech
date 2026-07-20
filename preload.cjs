const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('labtech', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  refreshOdds: () => ipcRenderer.invoke('odds:refresh'),
  addBet: (bet) => ipcRenderer.invoke('bet:add', bet),
  settleBet: (id, result) => ipcRenderer.invoke('bet:settle', { id, result }),
  decideBet: (id, decision) => ipcRenderer.invoke('bet:decide', { id, decision }),
  deleteBet: (id) => ipcRenderer.invoke('bet:delete', id),
  postToDiscord: (candidate) => ipcRenderer.invoke('discord:post', candidate),
  onBetsPruned: (callback) => ipcRenderer.on('bets:pruned', (_event, state) => callback(state)),
  onBoardAutoRefresh: (callback) => ipcRenderer.on('board:auto-refresh', (_event, board) => callback(board)),
  getVersion: () => ipcRenderer.invoke('app:version'),
});
