const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("questControl", {
  startRelay: () => ipcRenderer.invoke("relay:start"),
  stopRelay: () => ipcRenderer.invoke("relay:stop"),
  install: () => ipcRenderer.invoke("adb:install"),
  refresh: () => ipcRenderer.invoke("adb:refresh"),
  buildApk: () => ipcRenderer.invoke("apk:build"),
  checkUpdates: () => ipcRenderer.invoke("update:check"),
  updateApp: () => ipcRenderer.invoke("update:app"),
  updateApk: () => ipcRenderer.invoke("update:apk"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (value) => ipcRenderer.invoke("config:save", value),
  setAutoInstall: (value) => ipcRenderer.invoke("auto-install:set", value),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  openFolder: () => ipcRenderer.invoke("folder:open"),
  getState: () => ipcRenderer.invoke("state:get"),
  onLog: (callback) => ipcRenderer.on("log", (_event, line) => callback(line)),
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state))
});
