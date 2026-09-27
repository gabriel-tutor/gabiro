// The start window's only bridge to the main process. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gabiro", {
  list: () => ipcRenderer.invoke("gabiro:list"),
  open: (root) => ipcRenderer.invoke("gabiro:open", root),
  openFolder: () => ipcRenderer.invoke("gabiro:open-folder"),
  forget: (root) => ipcRenderer.invoke("gabiro:forget", root),
});
