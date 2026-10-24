import { app, BrowserWindow, desktopCapturer, ipcMain } from "electron";
import path from "node:path";
import { loadConfig, saveCredentials } from "./appConfig";
import type { AppConfig } from "./appConfig";
import { runPairingWindow } from "./pairingWindow";
import { toWebSocketUrl } from "../src/pairing/pairingClient";
import { SignalingClient } from "../src/signaling/signalingClient";
import { scanLan } from "../src/network/arpScanner";
import { Agent } from "../src/agent";
import { inputEventSchema } from "../src/rtc/inputEvent";
import { createElectronRtcHandler } from "./electronRtcHandler";
import { applyInputEvent } from "./inputInjector";
import { listRoots, listDirectory } from "./fileSystemBrowser";
import { DownloadManager } from "./downloadManager";
import { allowed, endSession, isActivePeer, startSession } from "./sessionGrants";

// This process never shows a window to the user — it's a background agent.
// The single hidden BrowserWindow exists only because screen capture and
// WebRTC require a renderer (Chromium) context; the main process itself has
// neither a DOM nor a WebRTC stack.
let captureWindow: BrowserWindow;
const downloads = new DownloadManager();
let signaling: SignalingClient | null = null;
let agent: Agent | null = null;

// Only one copy should run: two agents with the same credentials would keep
// replacing each other's connection.
if (!app.requestSingleInstanceLock()) app.quit();

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

/**
 * Makes sure this PC is linked to an account (showing the pairing window if
 * not), then connects. Runs again if the PC is later unlinked from the app.
 */
async function linkAndStart(config: AppConfig): Promise<void> {
  let credentials = config.credentials;
  if (!credentials) {
    credentials = await runPairingWindow(config.serverUrl, config.deviceName);
    if (!credentials) {
      app.quit(); // user closed the pairing window
      return;
    }
    saveCredentials(credentials);
  }

  signaling = new SignalingClient({
    url: toWebSocketUrl(config.serverUrl),
    deviceId: credentials.deviceId,
    secret: credentials.deviceSecret,
    name: config.deviceName,
  });

  const forwardToRenderer = createElectronRtcHandler(() => captureWindow);
  // A new offer starts a new viewer's session with that viewer's grants. A
  // running download belonged to the previous viewer: stop it, or its
  // remaining chunks would go to the new one.
  signaling.on("revoke", (peer) => {
    if (!isActivePeer(peer)) return;
    console.log(`[agent] access for ${peer} changed; ending their session`);
    endSession(peer);
    downloads.cancelAll();
    captureWindow.webContents.send("rtc:revoke", peer);
  });

  agent = new Agent({
    signaling,
    scanLan,
    handleSignal: (message) => {
      if ((message.payload as { kind?: unknown } | null)?.kind === "offer") {
        downloads.cancelAll();
        startSession(message.from, message.grants);
      }
      forwardToRenderer(message);
    },
    scanIntervalMs: config.scanIntervalMs,
    onUnauthorized: () => {
      agent?.stop();
      agent = null;
      signaling = null;
      saveCredentials(null);
      void linkAndStart({ ...config, credentials: null });
    },
  });
  agent.start();
}

app.on("second-instance", () => {
  // Nothing to focus when already linked (it runs in the background).
});

app.whenReady().then(() => {
  const config = loadConfig();

  captureWindow = createCaptureWindow();

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
    signaling?.send({ type: "signal", target, payload });
  });

  // Renderer forwards data-channel input events here because nut-js's
  // native mouse/keyboard bindings only work in the main process. Validated
  // again even though the renderer already validated it — cheap, and this
  // is still a boundary between two different pieces of code.
  ipcMain.on("rtc:input-event", (_event, raw: unknown) => {
    if (!allowed("control")) return; // this viewer may watch, not touch
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
    if (!allowed("files")) throw new Error("You don't have permission to browse files on this PC.");
    return dirPath === null ? listRoots() : listDirectory(dirPath);
  });

  // Download is a stream of events over time, not a single response, so it
  // uses fire-and-forget send/on rather than invoke/handle. Chunks are
  // converted to Uint8Array — Electron IPC's structured clone doesn't
  // reliably round-trip a Node Buffer subclass.
  ipcMain.on("files:download-request", (_event, requestId: string, filePath: string) => {
    if (!allowed("files")) {
      captureWindow.webContents.send("files:download-error", requestId, "You don't have permission to download files from this PC.");
      return;
    }
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

  void linkAndStart(config);
});
