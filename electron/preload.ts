import { contextBridge, ipcRenderer } from "electron";

// Runs with contextIsolation on, nodeIntegration off — the renderer gets
// only this narrow, explicit surface, never raw ipcRenderer/require access.
contextBridge.exposeInMainWorld("relay", {
  getPrimaryScreenSource: (): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke("desktop-sources:primary"),

  onIncomingSignal: (
    callback: (message: { from: string; payload: unknown; iceServers?: unknown[] }) => void
  ): void => {
    ipcRenderer.on("rtc:incoming-signal", (_event, message) => callback(message));
  },

  sendOutgoingSignal: (target: string, payload: unknown): void => {
    ipcRenderer.send("rtc:outgoing-signal", target, payload);
  },

  sendInputEvent: (event: unknown): void => {
    ipcRenderer.send("rtc:input-event", event);
  },

  listFiles: (dirPath: string | null): Promise<unknown> => ipcRenderer.invoke("files:list", dirPath),

  requestDownload: (requestId: string, filePath: string): void => {
    ipcRenderer.send("files:download-request", requestId, filePath);
  },
  pauseDownload: (requestId: string): void => ipcRenderer.send("files:download-pause", requestId),
  resumeDownload: (requestId: string): void => ipcRenderer.send("files:download-resume", requestId),
  cancelDownload: (requestId: string): void => ipcRenderer.send("files:download-cancel", requestId),

  onDownloadEvent: (
    callback: (
      event:
        | { kind: "start"; requestId: string; name: string; size: number }
        | { kind: "chunk"; requestId: string; data: Uint8Array }
        | { kind: "error"; requestId: string; message: string }
        | { kind: "complete"; requestId: string }
    ) => void
  ): void => {
    ipcRenderer.on("files:download-start", (_e, requestId, name, size) =>
      callback({ kind: "start", requestId, name, size })
    );
    ipcRenderer.on("files:download-chunk", (_e, requestId, data) => callback({ kind: "chunk", requestId, data }));
    ipcRenderer.on("files:download-error", (_e, requestId, message) =>
      callback({ kind: "error", requestId, message })
    );
    ipcRenderer.on("files:download-complete", (_e, requestId) => callback({ kind: "complete", requestId }));
  },
});
