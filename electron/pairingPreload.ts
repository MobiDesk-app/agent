import { contextBridge, ipcRenderer } from "electron";

// The pairing page only ever receives status updates; it can't call
// anything in the main process.
contextBridge.exposeInMainWorld("pairing", {
  onUpdate: (callback: (update: unknown) => void): void => {
    ipcRenderer.on("pairing:update", (_event, update) => callback(update));
  },
});
