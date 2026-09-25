import { contextBridge, ipcRenderer } from "electron";

// Runs with contextIsolation on, nodeIntegration off — the renderer gets
// only this narrow, explicit surface, never raw ipcRenderer/require access.
contextBridge.exposeInMainWorld("relay", {
  getPrimaryScreenSource: (): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke("desktop-sources:primary"),

  onIncomingSignal: (callback: (message: { from: string; payload: unknown }) => void): void => {
    ipcRenderer.on("rtc:incoming-signal", (_event, message) => callback(message));
  },

  sendOutgoingSignal: (target: string, payload: unknown): void => {
    ipcRenderer.send("rtc:outgoing-signal", target, payload);
  },

  sendInputEvent: (event: unknown): void => {
    ipcRenderer.send("rtc:input-event", event);
  },
});
