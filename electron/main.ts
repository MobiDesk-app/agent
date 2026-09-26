import { app, BrowserWindow, desktopCapturer, ipcMain } from "electron";
import path from "node:path";
import { loadConfigOrPrompt } from "./appConfig";
import { SignalingClient } from "../src/signaling/signalingClient";
import { scanLan } from "../src/network/arpScanner";
import { Agent } from "../src/agent";
import { inputEventSchema } from "../src/rtc/inputEvent";
import { createElectronRtcHandler } from "./electronRtcHandler";
import { applyInputEvent } from "./inputInjector";
import { listRoots, listDirectory } from "./fileSystemBrowser";
import { DownloadManager } from "./downloadManager";

// This process never shows a window to the user — it's a background agent.
// The single hidden BrowserWindow exists only because screen capture and
// WebRTC require a renderer (Chromium) context; the main process itself has
// neither a DOM nor a WebRTC stack.
let captureWindow: BrowserWindow;

function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "capture.html"));
  // The capture renderer has no window of its own to inspect, so forward
  // its console output into the agent's own logs.
  win.webContents.on("console-message", (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  return win;
}

app.whenReady().then(() => {
  const config = loadConfigOrPrompt();
  if (!config) {
    app.quit();
    return;
  }

  captureWindow = createCaptureWindow();
  const downloads = new DownloadManager();

  const signaling = new SignalingClient({
    url: config.backendUrl,
    token: config.authToken,
    deviceId: config.deviceId,
    name: config.deviceName,
  });

  const agent = new Agent({
    signaling,
    scanLan,
    handleSignal: createElectronRtcHandler(() => captureWindow),
    scanIntervalMs: config.scanIntervalMs,
  });
  agent.start();

  // Renderer asks main for a screen source id because desktopCapturer is
  // main-process-only; it then uses that id in its own getUserMedia call.
  ipcMain.handle("desktop-sources:primary", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const primary = sources[0];
    if (!primary) throw new Error("no screen source available to capture");
    return { id: primary.id, name: primary.name };
  });

  // Renderer produces answers/ICE candidates; only main talks to the backend.
  ipcMain.on("rtc:outgoing-signal", (_event, target: string, payload: unknown) => {
    signaling.send({ type: "signal", target, payload });
  });

  // Renderer forwards data-channel input events here because nut-js's
  // native mouse/keyboard bindings only work in the main process. Validated
  // again even though the renderer already validated it — cheap, and this
  // is still a boundary between two different pieces of code.
  ipcMain.on("rtc:input-event", (_event, raw: unknown) => {
    const result = inputEventSchema.safeParse(raw);
    if (!result.success) {
      console.warn("[input] dropped an invalid input event from renderer");
      return;
    }
    applyInputEvent(result.data).catch((err) => {
      console.error("[input] failed to apply input event:", err instanceof Error ? err.message : err);
    });
  });

  // File browsing: "list" is request/response (invoke). Full filesystem
  // read access here is intentional, not an oversight — see
  // fileSystemBrowser.ts's doc comment.
  ipcMain.handle("files:list", async (_event, dirPath: string | null) => {
    return dirPath === null ? listRoots() : listDirectory(dirPath);
  });

  // Download is a stream of events over time, not a single response, so it
  // uses fire-and-forget send/on rather than invoke/handle. Chunks are
  // converted to Uint8Array — Electron IPC's structured clone doesn't
  // reliably round-trip a Node Buffer subclass.
  ipcMain.on("files:download-request", (_event, requestId: string, filePath: string) => {
    downloads.start(requestId, filePath, {
      onStart: (name, size) => captureWindow.webContents.send("files:download-start", requestId, name, size),
      onChunk: (chunk) =>
        captureWindow.webContents.send("files:download-chunk", requestId, Uint8Array.from(chunk)),
      onError: (message) => captureWindow.webContents.send("files:download-error", requestId, message),
      onComplete: () => captureWindow.webContents.send("files:download-complete", requestId),
    });
  });
  ipcMain.on("files:download-pause", (_event, requestId: string) => downloads.pause(requestId));
  ipcMain.on("files:download-resume", (_event, requestId: string) => downloads.resume(requestId));
  ipcMain.on("files:download-cancel", (_event, requestId: string) => downloads.cancel(requestId));

  // Keep running with no windows open — this is a background agent, not a
  // normal app the user quits by closing a window.
  app.on("window-all-closed", () => {});
});
